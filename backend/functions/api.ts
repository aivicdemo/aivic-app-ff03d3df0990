import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { getUserFromEvent, hasPermission, PERMISSIONS } from './rbac';
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
}

interface APIGatewayResponse {
  statusCode: number;
  headers?: { [key: string]: string };
  body: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const TABLE_CONFIGS = {
  '0': { name: 'login_users', pk: 'USER', readPerm: PERMISSIONS.READ_USERS, writePerm: PERMISSIONS.WRITE_USERS },
  '1': { name: 'stores', pk: 'STORE', readPerm: PERMISSIONS.READ_STORES, writePerm: PERMISSIONS.WRITE_STORES },
  '2': { name: 'sales_data', pk: 'SALES', readPerm: PERMISSIONS.READ_SALES, writePerm: PERMISSIONS.WRITE_SALES },
  '3': { name: 'operation_logs', pk: 'OPERATION_LOG', readPerm: PERMISSIONS.READ_OPERATION_LOGS, writePerm: PERMISSIONS.WRITE_OPERATION_LOGS },
  '4': { name: 'location_data', pk: 'LOCATION', readPerm: PERMISSIONS.READ_LOCATION_DATA, writePerm: PERMISSIONS.WRITE_LOCATION_DATA },
  '5': { name: 'trade_area_analysis', pk: 'TRADE_AREA', readPerm: PERMISSIONS.READ_TRADE_AREA_ANALYSIS, writePerm: PERMISSIONS.WRITE_TRADE_AREA_ANALYSIS },
  '6': { name: 'competitor_research', pk: 'COMPETITOR_RESEARCH', readPerm: PERMISSIONS.READ_COMPETITOR_RESEARCH, writePerm: PERMISSIONS.WRITE_COMPETITOR_RESEARCH },
  '7': { name: 'candidate_locations', pk: 'CANDIDATE', readPerm: PERMISSIONS.READ_CANDIDATE_LOCATIONS, writePerm: PERMISSIONS.WRITE_CANDIDATE_LOCATIONS },
  '8': { name: 'population_data', pk: 'POPULATION', readPerm: PERMISSIONS.READ_POPULATION_DATA, writePerm: PERMISSIONS.WRITE_POPULATION_DATA },
  '9': { name: 'consumer_attributes', pk: 'CONSUMER_ATTR', readPerm: PERMISSIONS.READ_CONSUMER_ATTRIBUTES, writePerm: PERMISSIONS.WRITE_CONSUMER_ATTRIBUTES },
  '10': { name: 'market_size_results', pk: 'MARKET_SIZE', readPerm: PERMISSIONS.READ_MARKET_SIZE_RESULTS, writePerm: PERMISSIONS.WRITE_MARKET_SIZE_RESULTS },
  '11': { name: 'competitor_salons', pk: 'COMPETITOR_SALON', readPerm: PERMISSIONS.READ_COMPETITOR_SALONS, writePerm: PERMISSIONS.WRITE_COMPETITOR_SALONS },
  '12': { name: 'analysis_reports', pk: 'ANALYSIS_REPORT', readPerm: PERMISSIONS.READ_ANALYSIS_REPORTS, writePerm: PERMISSIONS.WRITE_ANALYSIS_REPORTS },
  '13': { name: 'data_collection_history', pk: 'DATA_COLLECTION', readPerm: PERMISSIONS.READ_DATA_COLLECTION_HISTORY, writePerm: PERMISSIONS.WRITE_DATA_COLLECTION_HISTORY }
};

async function createAuditLog(userId: string, action: string, tableName: string, details: any) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId,
    action,
    tableName,
    details: JSON.stringify(details),
    timestamp: new Date().toISOString()
  };
  
  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: auditLog
    }));
  } catch (error) {
    console.error('Failed to create audit log:', error);
  }
}

function createResponse(statusCode: number, body: any): APIGatewayResponse {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body)
  };
}

function validateRequired(data: any, fields: string[]): string[] {
  const errors: string[] = [];
  for (const field of fields) {
    if (!data[field]) {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

async function handleGetResources(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  const user = getUserFromEvent(event);
  if (!user) {
    return createResponse(401, { error: 'Unauthorized' });
  }

  const tableIndex = event.pathParameters?.tableIndex;
  if (!tableIndex || !TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS]) {
    return createResponse(400, { error: 'Invalid table index' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!hasPermission(user, config.readPerm)) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  const id = event.pathParameters?.id;
  
  try {
    if (id) {
      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: config.pk, sk: id }
      }));
      
      if (!result.Item) {
        return createResponse(404, { error: 'Resource not found' });
      }
      
      return createResponse(200, result.Item);
    } else {
      const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 50;
      const result = await docClient.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': config.pk },
        Limit: Math.min(limit, 100)
      }));
      
      return createResponse(200, {
        items: result.Items || [],
        count: result.Count || 0
      });
    }
  } catch (error) {
    console.error('Error fetching resources:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreateResource(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  const user = getUserFromEvent(event);
  if (!user) {
    return createResponse(401, { error: 'Unauthorized' });
  }

  const tableIndex = event.pathParameters?.tableIndex;
  if (!tableIndex || !TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS]) {
    return createResponse(400, { error: 'Invalid table index' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!hasPermission(user, config.writePerm)) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }

  try {
    const data = JSON.parse(event.body);
    const id = randomUUID();
    const now = new Date().toISOString();
    
    const item = {
      pk: config.pk,
      sk: id,
      id,
      ...data,
      createdAt: now,
      updatedAt: now,
      createdBy: user.id,
      updatedBy: user.id
    };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    }));

    await createAuditLog(user.id, 'CREATE', config.name, { id, data });

    return createResponse(201, item);
  } catch (error) {
    console.error('Error creating resource:', error);
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdateResource(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  const user = getUserFromEvent(event);
  if (!user) {
    return createResponse(401, { error: 'Unauthorized' });
  }

  const tableIndex = event.pathParameters?.tableIndex;
  const id = event.pathParameters?.id;
  
  if (!tableIndex || !TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS] || !id) {
    return createResponse(400, { error: 'Invalid table index or missing ID' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!hasPermission(user, config.writePerm)) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }

  try {
    const data = JSON.parse(event.body);
    const now = new Date().toISOString();
    
    const existingItem = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: config.pk, sk: id }
    }));
    
    if (!existingItem.Item) {
      return createResponse(404, { error: 'Resource not found' });
    }

    const updatedItem = {
      ...existingItem.Item,
      ...data,
      updatedAt: now,
      updatedBy: user.id
    };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedItem
    }));

    await createAuditLog(user.id, 'UPDATE', config.name, { id, oldData: existingItem.Item, newData: data });

    return createResponse(200, updatedItem);
  } catch (error) {
    console.error('Error updating resource:', error);
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDeleteResource(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  const user = getUserFromEvent(event);
  if (!user) {
    return createResponse(401, { error: 'Unauthorized' });
  }

  const tableIndex = event.pathParameters?.tableIndex;
  const id = event.pathParameters?.id;
  
  if (!tableIndex || !TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS] || !id) {
    return createResponse(400, { error: 'Invalid table index or missing ID' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!hasPermission(user, config.writePerm)) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const existingItem = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: config.pk, sk: id }
    }));
    
    if (!existingItem.Item) {
      return createResponse(404, { error: 'Resource not found' });
    }

    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { pk: config.pk, sk: id }
    }));

    await createAuditLog(user.id, 'DELETE', config.name, { id, deletedData: existingItem.Item });

    return createResponse(200, { message: 'Resource deleted successfully' });
  } catch (error) {
    console.error('Error deleting resource:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleBulkImport(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  const user = getUserFromEvent(event);
  if (!user) {
    return createResponse(401, { error: 'Unauthorized' });
  }

  if (!hasPermission(user, PERMISSIONS.BULK_IMPORT)) {
    return createResponse(403, { error: 'Insufficient permissions for bulk import' });
  }

  const tableIndex = event.pathParameters?.tableIndex;
  if (!tableIndex || !TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS]) {
    return createResponse(400, { error: 'Invalid table index' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!hasPermission(user, config.writePerm)) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }

  try {
    const { items } = JSON.parse(event.body);
    if (!Array.isArray(items)) {
      return createResponse(400, { error: 'Items must be an array' });
    }

    let imported = 0;
    let failed = 0;
    const errors: string[] = [];
    const now = new Date().toISOString();

    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      const writeRequests = batch.map(item => {
        const id = item.id || randomUUID();
        return {
          PutRequest: {
            Item: {
              pk: config.pk,
              sk: id,
              id,
              ...item,
              createdAt: item.createdAt || now,
              updatedAt: now,
              createdBy: item.createdBy || user.id,
              updatedBy: user.id
            }
          }
        };
      });

      try {
        await docClient.send(new BatchWriteCommand({
          RequestItems: {
            [TABLE_NAME]: writeRequests
          }
        }));
        imported += batch.length;
      } catch (error) {
        failed += batch.length;
        errors.push(`Batch ${Math.floor(i / 25) + 1}: ${error}`);
      }
    }

    await createAuditLog(user.id, 'BULK_IMPORT', config.name, { imported, failed, totalItems: items.length });

    return createResponse(200, { imported, failed, errors });
  } catch (error) {
    console.error('Error in bulk import:', error);
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }

  try {
    const path = event.path;
    const method = event.httpMethod;

    if (path === '/resources' && method === 'GET') {
      return await handleGetResources(event);
    }

    if (path.match(/^\/api\/\d+$/) && method === 'GET') {
      return await handleGetResources(event);
    }

    if (path.match(/^\/api\/\d+\/[^/]+$/) && method === 'GET') {
      return await handleGetResources(event);
    }

    if (path.match(/^\/api\/\d+$/) && method === 'POST') {
      return await handleCreateResource(event);
    }

    if (path.match(/^\/api\/\d+\/[^/]+$/) && method === 'PUT') {
      return await handleUpdateResource(event);
    }

    if (path.match(/^\/api\/\d+\/[^/]+$/) && method === 'DELETE') {
      return await handleDeleteResource(event);
    }

    if (path.match(/^\/api\/\d+\/bulk$/) && method === 'POST') {
      return await handleBulkImport(event);
    }

    return createResponse(404, { error: 'Not found' });
  } catch (error) {
    console.error('Unhandled error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};