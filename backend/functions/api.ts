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
      userAgent?: string;
    };
  };
}

interface APIGatewayResponse {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;
}

const TABLES = {
  '0': 'LOGIN_USER',
  '1': 'STORE',
  '2': 'SALES_DATA',
  '3': 'OPERATION_HISTORY',
  '4': 'LOCATION_DATA',
  '5': 'MARKET_ANALYSIS_RESULT',
  '6': 'COMPETITOR_SURVEY_DATA',
  '7': 'CANDIDATE_LOCATION',
  '8': 'POPULATION_STATISTICS_DATA',
  '9': 'CONSUMER_ATTRIBUTE_INFO',
  '10': 'MARKET_SIZE_CALCULATION_RESULT',
  '11': 'COMPETITOR_SALON',
  '12': 'ANALYSIS_REPORT',
  '13': 'DATA_COLLECTION_HISTORY'
};

function createResponse(statusCode: number, body: any): APIGatewayResponse {
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

async function createAuditLog(event: APIGatewayEvent, action: string, details: any) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    operationHistoryId: randomUUID(),
    userId: 'system',
    userName: 'system',
    operationType: action,
    operationContent: JSON.stringify(details),
    ipAddress: event.requestContext.identity.sourceIp,
    userAgent: event.requestContext.identity.userAgent || '',
    operationResult: 'success',
    sessionId: event.requestContext.requestId,
    operationDateTime: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

function validateTableIndex(tableIndex: string): string {
  const tableName = TABLES[tableIndex as keyof typeof TABLES];
  if (!tableName) {
    throw new Error('Invalid table index');
  }
  return tableName;
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

function generateId(tableName: string): string {
  return randomUUID();
}

function getPrimaryKey(tableName: string, id: string): { pk: string; sk?: string } {
  switch (tableName) {
    case 'LOGIN_USER':
      return { pk: 'USER', sk: id };
    case 'STORE':
      return { pk: 'STORE', sk: id };
    case 'SALES_DATA':
      return { pk: 'SALES', sk: id };
    case 'OPERATION_HISTORY':
      return { pk: 'OPERATION', sk: id };
    case 'LOCATION_DATA':
      return { pk: 'LOCATION', sk: id };
    case 'MARKET_ANALYSIS_RESULT':
      return { pk: 'MARKET_ANALYSIS', sk: id };
    case 'COMPETITOR_SURVEY_DATA':
      return { pk: 'COMPETITOR_SURVEY', sk: id };
    case 'CANDIDATE_LOCATION':
      return { pk: 'CANDIDATE', sk: id };
    case 'POPULATION_STATISTICS_DATA':
      return { pk: 'POPULATION', sk: id };
    case 'CONSUMER_ATTRIBUTE_INFO':
      return { pk: 'CONSUMER', sk: id };
    case 'MARKET_SIZE_CALCULATION_RESULT':
      return { pk: 'MARKET_SIZE', sk: id };
    case 'COMPETITOR_SALON':
      return { pk: 'SALON', sk: id };
    case 'ANALYSIS_REPORT':
      return { pk: 'REPORT', sk: id };
    case 'DATA_COLLECTION_HISTORY':
      return { pk: 'COLLECTION', sk: id };
    default:
      return { pk: tableName, sk: id };
  }
}

async function handleGetResources(event: APIGatewayEvent, role: Role): Promise<APIGatewayResponse> {
  if (!hasPermission(role, 'resources', 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const resources = {
      tables: Object.entries(TABLES).map(([index, name]) => ({
        index,
        name,
        displayName: name.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, l => l.toUpperCase())
      })),
      permissions: {
        canCreate: hasPermission(role, '*', 'create'),
        canUpdate: hasPermission(role, '*', 'update'),
        canDelete: hasPermission(role, '*', 'delete'),
        canBulkImport: hasPermission(role, '*', 'bulk')
      },
      userRole: role
    };

    return createResponse(200, resources);
  } catch (error) {
    console.error('Error getting resources:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetTableData(event: APIGatewayEvent, role: Role): Promise<APIGatewayResponse> {
  if (!hasPermission(role, 'table', 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const tableIndex = event.pathParameters?.tableIndex;
    if (!tableIndex) {
      return createResponse(400, { error: 'Table index is required' });
    }

    const tableName = validateTableIndex(tableIndex);
    const pk = getPrimaryKey(tableName, '').pk;

    const command = new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': pk
      }
    });

    const result = await docClient.send(command);
    return createResponse(200, { items: result.Items || [] });
  } catch (error) {
    console.error('Error getting table data:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetItem(event: APIGatewayEvent, role: Role): Promise<APIGatewayResponse> {
  if (!hasPermission(role, 'item', 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const { tableIndex, id } = event.pathParameters || {};
    if (!tableIndex || !id) {
      return createResponse(400, { error: 'Table index and ID are required' });
    }

    const tableName = validateTableIndex(tableIndex);
    const key = getPrimaryKey(tableName, id);

    const command = new GetCommand({
      TableName: TABLE_NAME,
      Key: key
    });

    const result = await docClient.send(command);
    if (!result.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    return createResponse(200, result.Item);
  } catch (error) {
    console.error('Error getting item:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreateItem(event: APIGatewayEvent, role: Role): Promise<APIGatewayResponse> {
  if (!hasPermission(role, 'item', 'create')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const tableIndex = event.pathParameters?.tableIndex;
    if (!tableIndex) {
      return createResponse(400, { error: 'Table index is required' });
    }

    const tableName = validateTableIndex(tableIndex);
    const body = JSON.parse(event.body || '{}');
    
    const id = generateId(tableName);
    const key = getPrimaryKey(tableName, id);
    const item = {
      ...key,
      ...body,
      id,
      ...addTimestamps(body)
    };

    const command = new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    });

    await docClient.send(command);
    await createAuditLog(event, 'CREATE', { tableName, id, item });

    return createResponse(201, item);
  } catch (error) {
    console.error('Error creating item:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdateItem(event: APIGatewayEvent, role: Role): Promise<APIGatewayResponse> {
  if (!hasPermission(role, 'item', 'update')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const { tableIndex, id } = event.pathParameters || {};
    if (!tableIndex || !id) {
      return createResponse(400, { error: 'Table index and ID are required' });
    }

    const tableName = validateTableIndex(tableIndex);
    const body = JSON.parse(event.body || '{}');
    const key = getPrimaryKey(tableName, id);
    
    const updatedItem = {
      ...key,
      ...body,
      id,
      ...addTimestamps(body, true)
    };

    const command = new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedItem
    });

    await docClient.send(command);
    await createAuditLog(event, 'UPDATE', { tableName, id, updatedItem });

    return createResponse(200, updatedItem);
  } catch (error) {
    console.error('Error updating item:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDeleteItem(event: APIGatewayEvent, role: Role): Promise<APIGatewayResponse> {
  if (!hasPermission(role, 'item', 'delete')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const { tableIndex, id } = event.pathParameters || {};
    if (!tableIndex || !id) {
      return createResponse(400, { error: 'Table index and ID are required' });
    }

    const tableName = validateTableIndex(tableIndex);
    const key = getPrimaryKey(tableName, id);

    const command = new DeleteCommand({
      TableName: TABLE_NAME,
      Key: key
    });

    await docClient.send(command);
    await createAuditLog(event, 'DELETE', { tableName, id });

    return createResponse(200, { message: 'Item deleted successfully' });
  } catch (error) {
    console.error('Error deleting item:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleBulkImport(event: APIGatewayEvent, role: Role): Promise<APIGatewayResponse> {
  if (!hasPermission(role, 'bulk', 'bulk')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const tableIndex = event.pathParameters?.tableIndex;
    if (!tableIndex) {
      return createResponse(400, { error: 'Table index is required' });
    }

    const tableName = validateTableIndex(tableIndex);
    const body = JSON.parse(event.body || '{}');
    const items = body.items || [];

    if (!Array.isArray(items)) {
      return createResponse(400, { error: 'Items must be an array' });
    }

    let imported = 0;
    let failed = 0;
    const errors: string[] = [];

    // Process items in batches of 25 (DynamoDB BatchWrite limit)
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      const writeRequests = batch.map(item => {
        const id = generateId(tableName);
        const key = getPrimaryKey(tableName, id);
        const processedItem = {
          ...key,
          ...item,
          id,
          ...addTimestamps(item)
        };

        return {
          PutRequest: {
            Item: processedItem
          }
        };
      });

      try {
        const command = new BatchWriteCommand({
          RequestItems: {
            [TABLE_NAME]: writeRequests
          }
        });

        await docClient.send(command);
        imported += batch.length;
      } catch (error) {
        failed += batch.length;
        errors.push(`Batch ${Math.floor(i / 25) + 1}: ${error}`);
      }
    }

    await createAuditLog(event, 'BULK_IMPORT', { 
      tableName, 
      totalItems: items.length, 
      imported, 
      failed 
    });

    return createResponse(200, { imported, failed, errors });
  } catch (error) {
    console.error('Error in bulk import:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }

  const role = extractUserRole(event);
  const path = event.path;
  const method = event.httpMethod;

  try {
    // GET /resources
    if (method === 'GET' && path === '/resources') {
      return await handleGetResources(event, role);
    }

    // GET /api/{tableIndex}
    if (method === 'GET' && path.match(/^\/api\/\d+$/)) {
      return await handleGetTableData(event, role);
    }

    // GET /api/{tableIndex}/{id}
    if (method === 'GET' && path.match(/^\/api\/\d+\/.+$/)) {
      return await handleGetItem(event, role);
    }

    // POST /api/{tableIndex}
    if (method === 'POST' && path.match(/^\/api\/\d+$/) && !path.includes('/bulk')) {
      return await handleCreateItem(event, role);
    }

    // POST /api/{tableIndex}/bulk
    if (method === 'POST' && path.match(/^\/api\/\d+\/bulk$/)) {
      return await handleBulkImport(event, role);
    }

    // PUT /api/{tableIndex}/{id}
    if (method === 'PUT' && path.match(/^\/api\/\d+\/.+$/)) {
      return await handleUpdateItem(event, role);
    }

    // DELETE /api/{tableIndex}/{id}
    if (method === 'DELETE' && path.match(/^\/api\/\d+\/.+$/)) {
      return await handleDeleteItem(event, role);
    }

    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};