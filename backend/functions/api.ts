import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserRole, Role } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface APIGatewayEvent {
  httpMethod: string;
  path: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  body?: string;
  headers?: { [key: string]: string };
  requestContext: {
    requestId: string;
    identity: {
      sourceIp: string;
      userAgent: string;
    };
  };
}

interface APIResponse {
  statusCode: number;
  headers: { [key: string]: string };
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

function createResponse(statusCode: number, body: any): APIResponse {
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

async function createAuditLog(userId: string, action: string, details: any, ip: string, userAgent: string) {
  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: 'AUDIT',
        sk: `${Date.now()}_${randomUUID()}`,
        userId,
        action,
        details: JSON.stringify(details),
        ipAddress: ip,
        userAgent,
        timestamp: new Date().toISOString(),
        createdAt: new Date().toISOString()
      }
    }));
  } catch (error) {
    console.error('Failed to create audit log:', error);
  }
}

function validateTableIndex(tableIndex: string): boolean {
  const index = parseInt(tableIndex);
  return !isNaN(index) && index >= 0 && index < TABLES.length;
}

function getTableName(tableIndex: string): string {
  const index = parseInt(tableIndex);
  return TABLES[index];
}

function addTimestamps(item: any, isUpdate = false): any {
  const now = new Date().toISOString();
  const result = { ...item };
  
  if (!isUpdate) {
    result.createdAt = now;
  }
  result.updatedAt = now;
  
  return result;
}

function generateId(): string {
  return randomUUID();
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

export async function handler(event: APIGatewayEvent): Promise<APIResponse> {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const userRole = extractUserRole(event);
    const userId = 'system';
    const ip = event.requestContext.identity.sourceIp;
    const userAgent = event.requestContext.identity.userAgent;

    // GET /resources
    if (event.httpMethod === 'GET' && event.path === '/resources') {
      if (!hasPermission(userRole, 'resources', 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      try {
        const resources = TABLES.map((table, index) => ({
          index,
          name: table,
          displayName: table.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
        }));

        return createResponse(200, { resources });
      } catch (error) {
        console.error('Error fetching resources:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // Parse path for table operations
    const pathMatch = event.path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(\w+))?$/);
    if (!pathMatch) {
      return createResponse(404, { error: 'Not found' });
    }

    const [, tableIndex, operation, itemId] = pathMatch;
    
    if (!validateTableIndex(tableIndex)) {
      return createResponse(400, { error: 'Invalid table index' });
    }

    const tableName = getTableName(tableIndex);

    // Bulk import endpoint
    if (event.httpMethod === 'POST' && operation === 'bulk') {
      if (!hasPermission(userRole, tableName, 'bulk')) {
        return createResponse(403, { error: 'Insufficient permissions for bulk operations' });
      }

      try {
        const body = JSON.parse(event.body || '{}');
        const items = body.items || [];

        if (!Array.isArray(items)) {
          return createResponse(400, { error: 'Items must be an array' });
        }

        let imported = 0;
        let failed = 0;
        const errors: string[] = [];

        const chunks = chunkArray(items, 25);

        for (const chunk of chunks) {
          const writeRequests = chunk.map(item => {
            const processedItem = addTimestamps({
              ...item,
              pk: tableName,
              sk: item.id || generateId()
            });

            return {
              PutRequest: {
                Item: processedItem
              }
            };
          });

          try {
            await docClient.send(new BatchWriteCommand({
              RequestItems: {
                [TABLE_NAME]: writeRequests
              }
            }));
            imported += chunk.length;
          } catch (error) {
            failed += chunk.length;
            errors.push(`Batch write failed: ${error}`);
          }
        }

        await createAuditLog(userId, 'BULK_IMPORT', {
          tableName,
          imported,
          failed,
          totalItems: items.length
        }, ip, userAgent);

        return createResponse(200, { imported, failed, errors });
      } catch (error) {
        console.error('Bulk import error:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // List items (GET /api/{tableIndex})
    if (event.httpMethod === 'GET' && !operation) {
      if (!hasPermission(userRole, tableName, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      try {
        const result = await docClient.send(new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: 'pk = :pk',
          ExpressionAttributeValues: {
            ':pk': tableName
          }
        }));

        return createResponse(200, { items: result.Items || [] });
      } catch (error) {
        console.error('Error scanning table:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // Get single item (GET /api/{tableIndex}/{id})
    if (event.httpMethod === 'GET' && operation && !itemId) {
      if (!hasPermission(userRole, tableName, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      try {
        const result = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableName,
            sk: operation
          }
        }));

        if (!result.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        return createResponse(200, result.Item);
      } catch (error) {
        console.error('Error getting item:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // Create item (POST /api/{tableIndex})
    if (event.httpMethod === 'POST' && !operation) {
      if (!hasPermission(userRole, tableName, 'create')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      try {
        const body = JSON.parse(event.body || '{}');
        const id = generateId();
        const item = addTimestamps({
          ...body,
          pk: tableName,
          sk: id
        });

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        }));

        await createAuditLog(userId, 'CREATE', {
          tableName,
          itemId: id,
          data: body
        }, ip, userAgent);

        return createResponse(201, item);
      } catch (error) {
        console.error('Error creating item:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // Update item (PUT /api/{tableIndex}/{id})
    if (event.httpMethod === 'PUT' && operation) {
      if (!hasPermission(userRole, tableName, 'update')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      try {
        const body = JSON.parse(event.body || '{}');
        const item = addTimestamps({
          ...body,
          pk: tableName,
          sk: operation
        }, true);

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        }));

        await createAuditLog(userId, 'UPDATE', {
          tableName,
          itemId: operation,
          data: body
        }, ip, userAgent);

        return createResponse(200, item);
      } catch (error) {
        console.error('Error updating item:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // Delete item (DELETE /api/{tableIndex}/{id})
    if (event.httpMethod === 'DELETE' && operation) {
      if (!hasPermission(userRole, tableName, 'delete')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      try {
        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableName,
            sk: operation
          }
        }));

        await createAuditLog(userId, 'DELETE', {
          tableName,
          itemId: operation
        }, ip, userAgent);

        return createResponse(200, { message: 'Item deleted successfully' });
      } catch (error) {
        console.error('Error deleting item:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    return createResponse(404, { error: 'Not found' });
  } catch (error) {
    console.error('Unhandled error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}