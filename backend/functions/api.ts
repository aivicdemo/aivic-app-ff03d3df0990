import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, validateRole, Role } from './rbac';
import * as crypto from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE || 'MainTable';

interface APIGatewayEvent {
  httpMethod: string;
  path: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  headers?: { [key: string]: string };
  body?: string;
}

interface APIGatewayResponse {
  statusCode: number;
  headers?: { [key: string]: string };
  body: string;
}

const TABLE_CONFIGS = {
  'login-users': { pk: 'LOGIN_USER', name: 'ログインユーザー' },
  'stores': { pk: 'STORE', name: '店舗' },
  'sales-data': { pk: 'SALES_DATA', name: '売上データ' },
  'operation-history': { pk: 'OPERATION_HISTORY', name: '操作履歴' },
  'location-data': { pk: 'LOCATION_DATA', name: '立地データ' },
  'trade-area-analysis': { pk: 'TRADE_AREA_ANALYSIS', name: '商圏分析結果' },
  'competitor-research': { pk: 'COMPETITOR_RESEARCH', name: '競合調査データ' },
  'candidate-locations': { pk: 'CANDIDATE_LOCATION', name: '候補地' },
  'demographic-data': { pk: 'DEMOGRAPHIC_DATA', name: '人口統計データ' },
  'consumer-attributes': { pk: 'CONSUMER_ATTRIBUTES', name: '消費者属性情報' },
  'market-size-results': { pk: 'MARKET_SIZE_RESULT', name: '市場規模算出結果' },
  'competitor-salons': { pk: 'COMPETITOR_SALON', name: '競合サロン' },
  'analysis-reports': { pk: 'ANALYSIS_REPORT', name: '分析レポート' },
  'data-collection-history': { pk: 'DATA_COLLECTION_HISTORY', name: 'データ収集履歴' }
};

function getUserRole(event: APIGatewayEvent): Role {
  const role = event.headers?.['x-user-role'] || 'viewer';
  return validateRole(role) ? role : 'viewer';
}

function getUserId(event: APIGatewayEvent): string {
  return event.headers?.['x-user-id'] || 'system';
}

async function createAuditLog(userId: string, action: string, tableName: string, details: any) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${crypto.randomUUID()}`,
    userId,
    action,
    tableName,
    details: JSON.stringify(details),
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

function createResponse(statusCode: number, body: any): APIGatewayResponse {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-user-role, x-user-id'
    },
    body: JSON.stringify(body)
  };
}

function validateTableKey(tableKey: string): boolean {
  return Object.keys(TABLE_CONFIGS).includes(tableKey);
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

async function handleGetResources(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  const role = getUserRole(event);
  
  if (!hasPermission(role, 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const resources = Object.entries(TABLE_CONFIGS).map(([key, config]) => ({
      key,
      name: config.name,
      pk: config.pk
    }));
    
    return createResponse(200, { resources });
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetTableData(event: APIGatewayEvent, tableKey: string): Promise<APIGatewayResponse> {
  const role = getUserRole(event);
  
  if (!hasPermission(role, 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  if (!validateTableKey(tableKey)) {
    return createResponse(404, { error: 'Table not found' });
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
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetTableItem(event: APIGatewayEvent, tableKey: string): Promise<APIGatewayResponse> {
  const role = getUserRole(event);
  
  if (!hasPermission(role, 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  if (!validateTableKey(tableKey)) {
    return createResponse(404, { error: 'Table not found' });
  }

  const id = event.pathParameters?.id;
  if (!id) {
    return createResponse(400, { error: 'ID parameter is required' });
  }

  try {
    const config = TABLE_CONFIGS[tableKey as keyof typeof TABLE_CONFIGS];
    const command = new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: id
      }
    });

    const result = await docClient.send(command);
    if (!result.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    return createResponse(200, result.Item);
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreateTableItem(event: APIGatewayEvent, tableKey: string): Promise<APIGatewayResponse> {
  const role = getUserRole(event);
  const userId = getUserId(event);
  
  if (!hasPermission(role, 'write')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  if (!validateTableKey(tableKey)) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }

  try {
    const body = JSON.parse(event.body);
    const config = TABLE_CONFIGS[tableKey as keyof typeof TABLE_CONFIGS];
    const id = generateId();
    
    const item = {
      pk: config.pk,
      sk: id,
      id,
      ...body,
      createdBy: userId,
      updatedBy: userId
    };
    
    addTimestamps(item);

    const command = new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    });

    await docClient.send(command);
    await createAuditLog(userId, 'CREATE', config.name, { id, data: body });

    return createResponse(201, item);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdateTableItem(event: APIGatewayEvent, tableKey: string): Promise<APIGatewayResponse> {
  const role = getUserRole(event);
  const userId = getUserId(event);
  
  if (!hasPermission(role, 'write')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  if (!validateTableKey(tableKey)) {
    return createResponse(404, { error: 'Table not found' });
  }

  const id = event.pathParameters?.id;
  if (!id) {
    return createResponse(400, { error: 'ID parameter is required' });
  }

  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }

  try {
    const body = JSON.parse(event.body);
    const config = TABLE_CONFIGS[tableKey as keyof typeof TABLE_CONFIGS];
    
    // Check if item exists
    const getCommand = new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: id
      }
    });
    
    const existingItem = await docClient.send(getCommand);
    if (!existingItem.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    const updatedItem = {
      ...existingItem.Item,
      ...body,
      updatedBy: userId
    };
    
    addTimestamps(updatedItem, true);

    const putCommand = new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedItem
    });

    await docClient.send(putCommand);
    await createAuditLog(userId, 'UPDATE', config.name, { id, oldData: existingItem.Item, newData: body });

    return createResponse(200, updatedItem);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDeleteTableItem(event: APIGatewayEvent, tableKey: string): Promise<APIGatewayResponse> {
  const role = getUserRole(event);
  const userId = getUserId(event);
  
  if (!hasPermission(role, 'delete')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  if (!validateTableKey(tableKey)) {
    return createResponse(404, { error: 'Table not found' });
  }

  const id = event.pathParameters?.id;
  if (!id) {
    return createResponse(400, { error: 'ID parameter is required' });
  }

  try {
    const config = TABLE_CONFIGS[tableKey as keyof typeof TABLE_CONFIGS];
    
    // Check if item exists
    const getCommand = new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: id
      }
    });
    
    const existingItem = await docClient.send(getCommand);
    if (!existingItem.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    const deleteCommand = new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: id
      }
    });

    await docClient.send(deleteCommand);
    await createAuditLog(userId, 'DELETE', config.name, { id, deletedData: existingItem.Item });

    return createResponse(200, { message: 'Item deleted successfully' });
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleBulkImport(event: APIGatewayEvent, tableKey: string): Promise<APIGatewayResponse> {
  const role = getUserRole(event);
  const userId = getUserId(event);
  
  if (!hasPermission(role, 'write')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  if (!validateTableKey(tableKey)) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }

  try {
    const body = JSON.parse(event.body);
    if (!body.items || !Array.isArray(body.items)) {
      return createResponse(400, { error: 'Request body must contain items array' });
    }

    const config = TABLE_CONFIGS[tableKey as keyof typeof TABLE_CONFIGS];
    const items = body.items;
    let imported = 0;
    let failed = 0;
    const errors: string[] = [];

    // Process in batches of 25 (DynamoDB BatchWrite limit)
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      const writeRequests = batch.map((item: any) => {
        const id = generateId();
        const processedItem = {
          pk: config.pk,
          sk: id,
          id,
          ...item,
          createdBy: userId,
          updatedBy: userId
        };
        addTimestamps(processedItem);
        
        return {
          PutRequest: {
            Item: processedItem
          }
        };
      });

      try {
        const batchCommand = new BatchWriteCommand({
          RequestItems: {
            [TABLE_NAME]: writeRequests
          }
        });

        const result = await docClient.send(batchCommand);
        
        // Handle unprocessed items
        if (result.UnprocessedItems && result.UnprocessedItems[TABLE_NAME]) {
          const unprocessedCount = result.UnprocessedItems[TABLE_NAME].length;
          failed += unprocessedCount;
          imported += (batch.length - unprocessedCount);
          errors.push(`${unprocessedCount} items failed to process in batch starting at index ${i}`);
        } else {
          imported += batch.length;
        }
      } catch (error) {
        failed += batch.length;
        errors.push(`Batch starting at index ${i} failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    await createAuditLog(userId, 'BULK_IMPORT', config.name, { 
      totalItems: items.length, 
      imported, 
      failed, 
      errors 
    });

    return createResponse(200, { imported, failed, errors });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

export async function handler(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }

  try {
    const path = event.path;
    const method = event.httpMethod;

    // GET /resources
    if (method === 'GET' && path === '/resources') {
      return await handleGetResources(event);
    }

    // Parse table-based routes
    const tableRouteMatch = path.match(/^\/api\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
    if (tableRouteMatch) {
      const tableKey = tableRouteMatch[1];
      const action = tableRouteMatch[2];
      const id = tableRouteMatch[3];

      // POST /api/{tableKey}/bulk
      if (method === 'POST' && action === 'bulk') {
        return await handleBulkImport(event, tableKey);
      }

      // GET /api/{tableKey}
      if (method === 'GET' && !action) {
        return await handleGetTableData(event, tableKey);
      }

      // GET /api/{tableKey}/{id}
      if (method === 'GET' && action && !id) {
        event.pathParameters = { id: action };
        return await handleGetTableItem(event, tableKey);
      }

      // POST /api/{tableKey}
      if (method === 'POST' && !action) {
        return await handleCreateTableItem(event, tableKey);
      }

      // PUT /api/{tableKey}/{id}
      if (method === 'PUT' && action && !id) {
        event.pathParameters = { id: action };
        return await handleUpdateTableItem(event, tableKey);
      }

      // DELETE /api/{tableKey}/{id}
      if (method === 'DELETE' && action && !id) {
        event.pathParameters = { id: action };
        return await handleDeleteTableItem(event, tableKey);
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}