import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, validateRole, Role } from './rbac';
import * as crypto from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface APIGatewayEvent {
  httpMethod: string;
  path: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  body?: string;
  headers: { [key: string]: string };
  requestContext: {
    identity: {
      sourceIp: string;
      userAgent: string;
    };
  };
}

interface APIGatewayResponse {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
};

const TABLE_CONFIGS = {
  'login-users': { pk: 'userId', name: 'ログインユーザー' },
  'stores': { pk: 'storeId', name: '店舗' },
  'sales-data': { pk: 'salesId', name: '売上データ' },
  'operation-history': { pk: 'operationHistoryId', name: '操作履歴' },
  'location-data': { pk: 'locationId', name: '立地データ' },
  'trade-area-analysis': { pk: 'tradeAreaAnalysisId', name: '商圏分析結果' },
  'competitor-research': { pk: 'competitorResearchId', name: '競合調査データ' },
  'candidate-locations': { pk: 'candidateLocationId', name: '候補地' },
  'demographic-data': { pk: 'demographicDataId', name: '人口統計データ' },
  'consumer-attributes': { pk: 'consumerAttributeId', name: '消費者属性情報' },
  'market-size-results': { pk: 'marketSizeResultId', name: '市場規模算出結果' },
  'competitor-salons': { pk: 'competitorSalonId', name: '競合サロン' },
  'analysis-reports': { pk: 'reportId', name: '分析レポート' },
  'data-collection-history': { pk: 'collectionHistoryId', name: 'データ収集履歴' }
};

function createResponse(statusCode: number, body: any): APIGatewayResponse {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body)
  };
}

function getUserRole(event: APIGatewayEvent): Role {
  const role = event.headers['x-user-role'] || event.headers['X-User-Role'] || 'viewer';
  return validateRole(role) ? role : 'viewer';
}

function getUserId(event: APIGatewayEvent): string {
  return event.headers['x-user-id'] || event.headers['X-User-Id'] || 'system';
}

async function createAuditLog(action: string, details: any, userId: string, ip: string, userAgent: string) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${crypto.randomUUID()}`,
    action,
    details,
    userId,
    ip,
    userAgent,
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

function getTableKey(tableName: string): string {
  const config = TABLE_CONFIGS[tableName as keyof typeof TABLE_CONFIGS];
  return config ? config.pk : 'id';
}

function getTableName(tableName: string): string {
  const config = TABLE_CONFIGS[tableName as keyof typeof TABLE_CONFIGS];
  return config ? config.name : tableName;
}

function addTimestamps(item: any, isUpdate: boolean = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

function generateId(): string {
  return crypto.randomUUID();
}

async function handleBulkImport(event: APIGatewayEvent, tableName: string): Promise<APIGatewayResponse> {
  const role = getUserRole(event);
  const userId = getUserId(event);
  
  if (!hasPermission(role, 'write')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }
  
  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }
  
  let requestBody;
  try {
    requestBody = JSON.parse(event.body);
  } catch (error) {
    return createResponse(400, { error: 'Invalid JSON in request body' });
  }
  
  if (!requestBody.items || !Array.isArray(requestBody.items)) {
    return createResponse(400, { error: 'items array is required' });
  }
  
  const items = requestBody.items;
  const tableKey = getTableKey(tableName);
  let imported = 0;
  let failed = 0;
  const errors: string[] = [];
  
  // Process in batches of 25 (DynamoDB BatchWrite limit)
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    const putRequests = batch.map(item => {
      const processedItem = {
        ...item,
        pk: tableName.toUpperCase(),
        sk: item[tableKey] || generateId()
      };
      addTimestamps(processedItem, false);
      processedItem.createdBy = userId;
      processedItem.updatedBy = userId;
      
      return {
        PutRequest: {
          Item: processedItem
        }
      };
    });
    
    try {
      const result = await docClient.send(new BatchWriteCommand({
        RequestItems: {
          [TABLE_NAME]: putRequests
        }
      }));
      
      const unprocessedCount = result.UnprocessedItems?.[TABLE_NAME]?.length || 0;
      imported += (batch.length - unprocessedCount);
      failed += unprocessedCount;
      
      if (unprocessedCount > 0) {
        errors.push(`Batch ${Math.floor(i/25) + 1}: ${unprocessedCount} items failed to process`);
      }
    } catch (error) {
      failed += batch.length;
      errors.push(`Batch ${Math.floor(i/25) + 1}: ${error}`);
    }
  }
  
  await createAuditLog(
    'BULK_IMPORT',
    { tableName: getTableName(tableName), imported, failed, totalItems: items.length },
    userId,
    event.requestContext.identity.sourceIp,
    event.requestContext.identity.userAgent
  );
  
  return createResponse(200, { imported, failed, errors });
}

async function handleGetResources(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  const role = getUserRole(event);
  
  if (!hasPermission(role, 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }
  
  try {
    const resources = Object.entries(TABLE_CONFIGS).map(([key, config]) => ({
      id: key,
      name: config.name,
      primaryKey: config.pk
    }));
    
    return createResponse(200, { resources });
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetTableData(event: APIGatewayEvent, tableName: string): Promise<APIGatewayResponse> {
  const role = getUserRole(event);
  
  if (!hasPermission(role, 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }
  
  try {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': tableName.toUpperCase()
      }
    }));
    
    return createResponse(200, { items: result.Items || [] });
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetTableItem(event: APIGatewayEvent, tableName: string): Promise<APIGatewayResponse> {
  const role = getUserRole(event);
  
  if (!hasPermission(role, 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }
  
  const id = event.pathParameters?.id;
  if (!id) {
    return createResponse(400, { error: 'ID parameter is required' });
  }
  
  try {
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: tableName.toUpperCase(),
        sk: id
      }
    }));
    
    if (!result.Item) {
      return createResponse(404, { error: 'Item not found' });
    }
    
    return createResponse(200, result.Item);
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreateTableItem(event: APIGatewayEvent, tableName: string): Promise<APIGatewayResponse> {
  const role = getUserRole(event);
  const userId = getUserId(event);
  
  if (!hasPermission(role, 'write')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }
  
  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }
  
  let item;
  try {
    item = JSON.parse(event.body);
  } catch (error) {
    return createResponse(400, { error: 'Invalid JSON in request body' });
  }
  
  const tableKey = getTableKey(tableName);
  const id = item[tableKey] || generateId();
  
  const newItem = {
    ...item,
    pk: tableName.toUpperCase(),
    sk: id,
    [tableKey]: id,
    createdBy: userId,
    updatedBy: userId
  };
  
  addTimestamps(newItem, false);
  
  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: newItem
    }));
    
    await createAuditLog(
      'CREATE',
      { tableName: getTableName(tableName), itemId: id },
      userId,
      event.requestContext.identity.sourceIp,
      event.requestContext.identity.userAgent
    );
    
    return createResponse(201, newItem);
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdateTableItem(event: APIGatewayEvent, tableName: string): Promise<APIGatewayResponse> {
  const role = getUserRole(event);
  const userId = getUserId(event);
  
  if (!hasPermission(role, 'write')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }
  
  const id = event.pathParameters?.id;
  if (!id) {
    return createResponse(400, { error: 'ID parameter is required' });
  }
  
  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }
  
  let updates;
  try {
    updates = JSON.parse(event.body);
  } catch (error) {
    return createResponse(400, { error: 'Invalid JSON in request body' });
  }
  
  // Get existing item first
  try {
    const existingResult = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: tableName.toUpperCase(),
        sk: id
      }
    }));
    
    if (!existingResult.Item) {
      return createResponse(404, { error: 'Item not found' });
    }
    
    const tableKey = getTableKey(tableName);
    const updatedItem = {
      ...existingResult.Item,
      ...updates,
      pk: tableName.toUpperCase(),
      sk: id,
      [tableKey]: id,
      updatedBy: userId
    };
    
    addTimestamps(updatedItem, true);
    
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedItem
    }));
    
    await createAuditLog(
      'UPDATE',
      { tableName: getTableName(tableName), itemId: id },
      userId,
      event.requestContext.identity.sourceIp,
      event.requestContext.identity.userAgent
    );
    
    return createResponse(200, updatedItem);
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDeleteTableItem(event: APIGatewayEvent, tableName: string): Promise<APIGatewayResponse> {
  const role = getUserRole(event);
  const userId = getUserId(event);
  
  if (!hasPermission(role, 'delete')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }
  
  const id = event.pathParameters?.id;
  if (!id) {
    return createResponse(400, { error: 'ID parameter is required' });
  }
  
  try {
    // Check if item exists first
    const existingResult = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: tableName.toUpperCase(),
        sk: id
      }
    }));
    
    if (!existingResult.Item) {
      return createResponse(404, { error: 'Item not found' });
    }
    
    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: tableName.toUpperCase(),
        sk: id
      }
    }));
    
    await createAuditLog(
      'DELETE',
      { tableName: getTableName(tableName), itemId: id },
      userId,
      event.requestContext.identity.sourceIp,
      event.requestContext.identity.userAgent
    );
    
    return createResponse(200, { message: 'Item deleted successfully' });
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

export async function handler(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }
  
  const path = event.path;
  const method = event.httpMethod;
  
  // Handle /resources endpoint
  if (path === '/resources' && method === 'GET') {
    return handleGetResources(event);
  }
  
  // Handle table-specific endpoints
  const tableMatch = path.match(/^\/api\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
  if (!tableMatch) {
    return createResponse(404, { error: 'Endpoint not found' });
  }
  
  const [, tableName, action, id] = tableMatch;
  
  if (!TABLE_CONFIGS[tableName as keyof typeof TABLE_CONFIGS]) {
    return createResponse(404, { error: 'Table not found' });
  }
  
  // Handle bulk import
  if (action === 'bulk' && method === 'POST') {
    return handleBulkImport(event, tableName);
  }
  
  // Handle CRUD operations
  if (!action) {
    // /api/{table}
    if (method === 'GET') {
      return handleGetTableData(event, tableName);
    } else if (method === 'POST') {
      return handleCreateTableItem(event, tableName);
    }
  } else if (action && !id) {
    // /api/{table}/{id}
    const itemId = action;
    const updatedEvent = { ...event, pathParameters: { ...event.pathParameters, id: itemId } };
    
    if (method === 'GET') {
      return handleGetTableItem(updatedEvent, tableName);
    } else if (method === 'PUT') {
      return handleUpdateTableItem(updatedEvent, tableName);
    } else if (method === 'DELETE') {
      return handleDeleteTableItem(updatedEvent, tableName);
    }
  }
  
  return createResponse(404, { error: 'Endpoint not found' });
}