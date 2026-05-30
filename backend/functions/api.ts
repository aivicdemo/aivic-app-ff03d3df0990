import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserRole, extractUserId, UserRole } from './rbac';
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
  requestContext: any;
}

interface APIGatewayProxyResult {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;
}

const TABLE_CONFIGS = {
  'login-users': { pk: 'LOGIN_USER', name: 'ログインユーザー' },
  'stores': { pk: 'STORE', name: '店舗' },
  'sales-data': { pk: 'SALES_DATA', name: '売上データ' },
  'operation-history': { pk: 'OPERATION_HISTORY', name: '操作履歴' },
  'location-data': { pk: 'LOCATION_DATA', name: '立地データ' },
  'market-analysis': { pk: 'MARKET_ANALYSIS', name: '商圏分析結果' },
  'competitor-research': { pk: 'COMPETITOR_RESEARCH', name: '競合調査データ' },
  'candidate-locations': { pk: 'CANDIDATE_LOCATION', name: '候補地' },
  'demographic-data': { pk: 'DEMOGRAPHIC_DATA', name: '人口統計データ' },
  'consumer-attributes': { pk: 'CONSUMER_ATTRIBUTES', name: '消費者属性情報' },
  'market-size-results': { pk: 'MARKET_SIZE_RESULT', name: '市場規模算出結果' },
  'competitor-salons': { pk: 'COMPETITOR_SALON', name: '競合サロン' },
  'analysis-reports': { pk: 'ANALYSIS_REPORT', name: '分析レポート' },
  'data-collection-history': { pk: 'DATA_COLLECTION_HISTORY', name: 'データ収集履歴' }
};

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-user-role, x-user-id'
    },
    body: JSON.stringify(body)
  };
}

function createErrorResponse(statusCode: number, message: string): APIGatewayProxyResult {
  return createResponse(statusCode, { error: message });
}

async function createAuditLog(userId: string, action: string, resource: string, details: any = {}) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId,
    action,
    resource,
    details,
    timestamp: new Date().toISOString(),
    createdAt: new Date().toISOString()
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

function validateTableKey(tableKey: string): boolean {
  return Object.keys(TABLE_CONFIGS).includes(tableKey);
}

function addTimestamps(item: any, isUpdate: boolean = false): any {
  const now = new Date().toISOString();
  const result = { ...item };
  
  if (!isUpdate) {
    result.createdAt = now;
  }
  result.updatedAt = now;
  
  return result;
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

async function handleGetResources(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const role = extractUserRole(event);
  
  if (!hasPermission(role, 'resources', 'read')) {
    return createErrorResponse(403, 'Insufficient permissions');
  }
  
  try {
    const resources = Object.entries(TABLE_CONFIGS).map(([key, config]) => ({
      key,
      name: config.name,
      pk: config.pk
    }));
    
    return createResponse(200, { resources });
  } catch (error) {
    console.error('Error fetching resources:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleGetTableData(event: APIGatewayProxyEvent, tableKey: string): Promise<APIGatewayProxyResult> {
  const role = extractUserRole(event);
  
  if (!hasPermission(role, tableKey, 'read')) {
    return createErrorResponse(403, 'Insufficient permissions');
  }
  
  if (!validateTableKey(tableKey)) {
    return createErrorResponse(404, 'Table not found');
  }
  
  try {
    const config = TABLE_CONFIGS[tableKey as keyof typeof TABLE_CONFIGS];
    const command = new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': config.pk
      }
    });
    
    const result = await docClient.send(command);
    return createResponse(200, { items: result.Items || [] });
  } catch (error) {
    console.error('Error fetching table data:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleGetTableItem(event: APIGatewayProxyEvent, tableKey: string): Promise<APIGatewayProxyResult> {
  const role = extractUserRole(event);
  const itemId = event.pathParameters?.id;
  
  if (!hasPermission(role, tableKey, 'read')) {
    return createErrorResponse(403, 'Insufficient permissions');
  }
  
  if (!validateTableKey(tableKey)) {
    return createErrorResponse(404, 'Table not found');
  }
  
  if (!itemId) {
    return createErrorResponse(400, 'Item ID is required');
  }
  
  try {
    const config = TABLE_CONFIGS[tableKey as keyof typeof TABLE_CONFIGS];
    const command = new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: itemId
      }
    });
    
    const result = await docClient.send(command);
    
    if (!result.Item) {
      return createErrorResponse(404, 'Item not found');
    }
    
    return createResponse(200, result.Item);
  } catch (error) {
    console.error('Error fetching item:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleCreateTableItem(event: APIGatewayProxyEvent, tableKey: string): Promise<APIGatewayProxyResult> {
  const role = extractUserRole(event);
  const userId = extractUserId(event);
  
  if (!hasPermission(role, tableKey, 'create')) {
    return createErrorResponse(403, 'Insufficient permissions');
  }
  
  if (!validateTableKey(tableKey)) {
    return createErrorResponse(404, 'Table not found');
  }
  
  if (!event.body) {
    return createErrorResponse(400, 'Request body is required');
  }
  
  try {
    const body = JSON.parse(event.body);
    const config = TABLE_CONFIGS[tableKey as keyof typeof TABLE_CONFIGS];
    
    const item = addTimestamps({
      pk: config.pk,
      sk: body.id || randomUUID(),
      ...body,
      createdBy: userId,
      updatedBy: userId
    });
    
    const command = new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    });
    
    await docClient.send(command);
    await createAuditLog(userId, 'CREATE', tableKey, { itemId: item.sk });
    
    return createResponse(201, item);
  } catch (error) {
    console.error('Error creating item:', error);
    if (error instanceof SyntaxError) {
      return createErrorResponse(400, 'Invalid JSON in request body');
    }
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleUpdateTableItem(event: APIGatewayProxyEvent, tableKey: string): Promise<APIGatewayProxyResult> {
  const role = extractUserRole(event);
  const userId = extractUserId(event);
  const itemId = event.pathParameters?.id;
  
  if (!hasPermission(role, tableKey, 'update')) {
    return createErrorResponse(403, 'Insufficient permissions');
  }
  
  if (!validateTableKey(tableKey)) {
    return createErrorResponse(404, 'Table not found');
  }
  
  if (!itemId || !event.body) {
    return createErrorResponse(400, 'Item ID and request body are required');
  }
  
  try {
    const body = JSON.parse(event.body);
    const config = TABLE_CONFIGS[tableKey as keyof typeof TABLE_CONFIGS];
    
    const updateData = addTimestamps({
      ...body,
      updatedBy: userId
    }, true);
    
    const updateExpression = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(updateData)) {
      if (key !== 'pk' && key !== 'sk') {
        updateExpression.push(`#${key} = :${key}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      }
    }
    
    const command = new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: itemId
      },
      UpdateExpression: `SET ${updateExpression.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    });
    
    const result = await docClient.send(command);
    await createAuditLog(userId, 'UPDATE', tableKey, { itemId });
    
    return createResponse(200, result.Attributes);
  } catch (error) {
    console.error('Error updating item:', error);
    if (error instanceof SyntaxError) {
      return createErrorResponse(400, 'Invalid JSON in request body');
    }
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleDeleteTableItem(event: APIGatewayProxyEvent, tableKey: string): Promise<APIGatewayProxyResult> {
  const role = extractUserRole(event);
  const userId = extractUserId(event);
  const itemId = event.pathParameters?.id;
  
  if (!hasPermission(role, tableKey, 'delete')) {
    return createErrorResponse(403, 'Insufficient permissions');
  }
  
  if (!validateTableKey(tableKey)) {
    return createErrorResponse(404, 'Table not found');
  }
  
  if (!itemId) {
    return createErrorResponse(400, 'Item ID is required');
  }
  
  try {
    const config = TABLE_CONFIGS[tableKey as keyof typeof TABLE_CONFIGS];
    
    const command = new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: itemId
      },
      ReturnValues: 'ALL_OLD'
    });
    
    const result = await docClient.send(command);
    
    if (!result.Attributes) {
      return createErrorResponse(404, 'Item not found');
    }
    
    await createAuditLog(userId, 'DELETE', tableKey, { itemId });
    
    return createResponse(200, { message: 'Item deleted successfully' });
  } catch (error) {
    console.error('Error deleting item:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleBulkImport(event: APIGatewayProxyEvent, tableKey: string): Promise<APIGatewayProxyResult> {
  const role = extractUserRole(event);
  const userId = extractUserId(event);
  
  if (!hasPermission(role, tableKey, 'bulk')) {
    return createErrorResponse(403, 'Insufficient permissions');
  }
  
  if (!validateTableKey(tableKey)) {
    return createErrorResponse(404, 'Table not found');
  }
  
  if (!event.body) {
    return createErrorResponse(400, 'Request body is required');
  }
  
  try {
    const body = JSON.parse(event.body);
    
    if (!body.items || !Array.isArray(body.items)) {
      return createErrorResponse(400, 'Items array is required');
    }
    
    const config = TABLE_CONFIGS[tableKey as keyof typeof TABLE_CONFIGS];
    const items = body.items.map((item: any) => addTimestamps({
      pk: config.pk,
      sk: item.id || randomUUID(),
      ...item,
      createdBy: userId,
      updatedBy: userId
    }));
    
    const chunks = chunkArray(items, 25);
    let imported = 0;
    let failed = 0;
    const errors: string[] = [];
    
    for (const chunk of chunks) {
      try {
        const writeRequests = chunk.map(item => ({
          PutRequest: {
            Item: item
          }
        }));
        
        const command = new BatchWriteCommand({
          RequestItems: {
            [TABLE_NAME]: writeRequests
          }
        });
        
        await docClient.send(command);
        imported += chunk.length;
      } catch (error) {
        failed += chunk.length;
        errors.push(`Batch write failed: ${error}`);
      }
    }
    
    await createAuditLog(userId, 'BULK_IMPORT', tableKey, { imported, failed, total: items.length });
    
    return createResponse(200, { imported, failed, errors });
  } catch (error) {
    console.error('Error in bulk import:', error);
    if (error instanceof SyntaxError) {
      return createErrorResponse(400, 'Invalid JSON in request body');
    }
    return createErrorResponse(500, 'Internal server error');
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }
  
  try {
    const path = event.path;
    const method = event.httpMethod;
    
    if (path === '/resources' && method === 'GET') {
      return await handleGetResources(event);
    }
    
    const apiMatch = path.match(/^\/api\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
    if (!apiMatch) {
      return createErrorResponse(404, 'Endpoint not found');
    }
    
    const [, tableKey, action, itemId] = apiMatch;
    
    if (action === 'bulk' && method === 'POST') {
      return await handleBulkImport(event, tableKey);
    }
    
    if (!action) {
      if (method === 'GET') {
        return await handleGetTableData(event, tableKey);
      } else if (method === 'POST') {
        return await handleCreateTableItem(event, tableKey);
      }
    } else if (action && !itemId) {
      if (method === 'GET') {
        return await handleGetTableItem(event, tableKey);
      } else if (method === 'PUT') {
        return await handleUpdateTableItem(event, tableKey);
      } else if (method === 'DELETE') {
        return await handleDeleteTableItem(event, tableKey);
      }
    } else if (itemId) {
      event.pathParameters = { ...event.pathParameters, id: action };
      if (method === 'GET') {
        return await handleGetTableItem(event, tableKey);
      } else if (method === 'PUT') {
        return await handleUpdateTableItem(event, tableKey);
      } else if (method === 'DELETE') {
        return await handleDeleteTableItem(event, tableKey);
      }
    }
    
    return createErrorResponse(404, 'Endpoint not found');
  } catch (error) {
    console.error('Unhandled error:', error);
    return createErrorResponse(500, 'Internal server error');
  }
};