import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserRole, Role } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface APIGatewayProxyEvent {
  httpMethod: string;
  path: string;
  pathParameters?: { [key: string]: string } | null;
  queryStringParameters?: { [key: string]: string } | null;
  body?: string | null;
  headers: { [key: string]: string };
  requestContext: {
    requestId: string;
    identity: {
      sourceIp: string;
      userAgent?: string;
    };
  };
}

interface APIGatewayProxyResult {
  statusCode: number;
  headers?: { [key: string]: string };
  body: string;
}

const TABLES = [
  'login_users',
  'stores', 
  'sales_data',
  'operation_history',
  'location_data',
  'trade_area_analysis',
  'competitor_research',
  'candidate_locations',
  'demographic_data',
  'consumer_attributes',
  'market_size_results',
  'competitor_salons',
  'analysis_reports',
  'data_collection_history'
];

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    },
    body: JSON.stringify(body)
  };
}

function validateTableIndex(tableIndex: string): string | null {
  const index = parseInt(tableIndex);
  if (isNaN(index) || index < 0 || index >= TABLES.length) {
    return null;
  }
  return TABLES[index];
}

async function createAuditLog(event: APIGatewayProxyEvent, action: string, details: any) {
  try {
    const auditItem = {
      pk: 'AUDIT',
      sk: `${Date.now()}_${randomUUID()}`,
      action,
      details: JSON.stringify(details),
      ip: event.requestContext.identity.sourceIp,
      userAgent: event.requestContext.identity.userAgent || '',
      timestamp: new Date().toISOString(),
      requestId: event.requestContext.requestId
    };
    
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: auditItem
    }));
  } catch (error) {
    console.error('Failed to create audit log:', error);
  }
}

function addTimestamps(item: any, isUpdate = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

function generateId(): string {
  return randomUUID();
}

async function handleBulkImport(event: APIGatewayProxyEvent, tableName: string, userRole: Role): Promise<APIGatewayProxyResult> {
  if (!hasPermission(userRole, tableName, 'bulk')) {
    return createResponse(403, { error: 'Insufficient permissions for bulk import' });
  }

  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }

  let requestBody: { items: Record<string, unknown>[] };
  try {
    requestBody = JSON.parse(event.body);
  } catch {
    return createResponse(400, { error: 'Invalid JSON in request body' });
  }

  if (!requestBody.items || !Array.isArray(requestBody.items)) {
    return createResponse(400, { error: 'items array is required' });
  }

  const items = requestBody.items.map(item => {
    const processedItem = { ...item };
    if (!processedItem.id) {
      processedItem.id = generateId();
    }
    processedItem.pk = tableName;
    processedItem.sk = processedItem.id;
    return addTimestamps(processedItem);
  });

  let imported = 0;
  let failed = 0;
  const errors: string[] = [];

  // Process in batches of 25 (DynamoDB BatchWrite limit)
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    const putRequests = batch.map(item => ({
      PutRequest: { Item: item }
    }));

    try {
      await docClient.send(new BatchWriteCommand({
        RequestItems: {
          [TABLE_NAME]: putRequests
        }
      }));
      imported += batch.length;
    } catch (error) {
      failed += batch.length;
      errors.push(`Batch ${Math.floor(i / 25) + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  await createAuditLog(event, 'BULK_IMPORT', {
    tableName,
    imported,
    failed,
    totalItems: items.length
  });

  return createResponse(200, { imported, failed, errors });
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const userRole = extractUserRole(event);
    const method = event.httpMethod;
    const path = event.path;

    // Handle OPTIONS for CORS
    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    // Handle /resources endpoint
    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(userRole, 'resources', 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      try {
        const result = await docClient.send(new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: 'pk <> :auditPk',
          ExpressionAttributeValues: {
            ':auditPk': 'AUDIT'
          }
        }));

        const groupedData: Record<string, any[]> = {};
        TABLES.forEach(table => {
          groupedData[table] = [];
        });

        result.Items?.forEach(item => {
          if (item.pk && TABLES.includes(item.pk)) {
            groupedData[item.pk].push(item);
          }
        });

        return createResponse(200, {
          tables: TABLES,
          data: groupedData,
          total: result.Items?.length || 0
        });
      } catch (error) {
        console.error('Error fetching resources:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // Parse table-specific routes
    const pathMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(bulk))?$/);
    if (!pathMatch) {
      return createResponse(404, { error: 'Endpoint not found' });
    }

    const [, tableIndexStr, itemId, bulkFlag] = pathMatch;
    const tableName = validateTableIndex(tableIndexStr);
    
    if (!tableName) {
      return createResponse(400, { error: 'Invalid table index' });
    }

    // Handle bulk import
    if (bulkFlag === 'bulk' && method === 'POST') {
      return handleBulkImport(event, tableName, userRole);
    }

    // Handle CRUD operations
    switch (method) {
      case 'GET':
        if (!hasPermission(userRole, tableName, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (itemId) {
          // Get single item
          try {
            const result = await docClient.send(new GetCommand({
              TableName: TABLE_NAME,
              Key: { pk: tableName, sk: itemId }
            }));

            if (!result.Item) {
              return createResponse(404, { error: 'Item not found' });
            }

            return createResponse(200, result.Item);
          } catch (error) {
            console.error('Error getting item:', error);
            return createResponse(500, { error: 'Internal server error' });
          }
        } else {
          // Get all items for table
          try {
            const result = await docClient.send(new ScanCommand({
              TableName: TABLE_NAME,
              FilterExpression: 'pk = :pk',
              ExpressionAttributeValues: {
                ':pk': tableName
              }
            }));

            return createResponse(200, {
              items: result.Items || [],
              count: result.Items?.length || 0
            });
          } catch (error) {
            console.error('Error scanning table:', error);
            return createResponse(500, { error: 'Internal server error' });
          }
        }

      case 'POST':
        if (!hasPermission(userRole, tableName, 'create')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (!event.body) {
          return createResponse(400, { error: 'Request body is required' });
        }

        try {
          const item = JSON.parse(event.body);
          const id = item.id || generateId();
          
          const newItem = {
            ...item,
            pk: tableName,
            sk: id,
            id
          };
          
          addTimestamps(newItem);

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: newItem
          }));

          await createAuditLog(event, 'CREATE', { tableName, itemId: id });

          return createResponse(201, newItem);
        } catch (error) {
          console.error('Error creating item:', error);
          return createResponse(500, { error: 'Internal server error' });
        }

      case 'PUT':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID is required for updates' });
        }

        if (!hasPermission(userRole, tableName, 'update')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (!event.body) {
          return createResponse(400, { error: 'Request body is required' });
        }

        try {
          const updates = JSON.parse(event.body);
          
          // Check if item exists
          const existing = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: tableName, sk: itemId }
          }));

          if (!existing.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          const updatedItem = {
            ...existing.Item,
            ...updates,
            pk: tableName,
            sk: itemId,
            id: itemId
          };
          
          addTimestamps(updatedItem, true);

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          }));

          await createAuditLog(event, 'UPDATE', { tableName, itemId });

          return createResponse(200, updatedItem);
        } catch (error) {
          console.error('Error updating item:', error);
          return createResponse(500, { error: 'Internal server error' });
        }

      case 'DELETE':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID is required for deletion' });
        }

        if (!hasPermission(userRole, tableName, 'delete')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        try {
          // Check if item exists
          const existing = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: tableName, sk: itemId }
          }));

          if (!existing.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { pk: tableName, sk: itemId }
          }));

          await createAuditLog(event, 'DELETE', { tableName, itemId });

          return createResponse(200, { message: 'Item deleted successfully' });
        } catch (error) {
          console.error('Error deleting item:', error);
          return createResponse(500, { error: 'Internal server error' });
        }

      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Unexpected error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};