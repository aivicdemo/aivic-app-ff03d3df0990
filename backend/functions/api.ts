import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, validateRole, Role } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE || 'store-strategy-table';

interface APIGatewayEvent {
  httpMethod: string;
  path: string;
  pathParameters?: { [key: string]: string } | null;
  queryStringParameters?: { [key: string]: string } | null;
  body?: string | null;
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
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Role'
};

const TABLE_CONFIGS = {
  'login-users': { pk: 'LOGIN_USER', name: 'ログインユーザー' },
  'stores': { pk: 'STORE', name: '店舗' },
  'sales-data': { pk: 'SALES_DATA', name: '売上データ' },
  'operation-logs': { pk: 'OPERATION_LOG', name: '操作履歴' },
  'location-data': { pk: 'LOCATION_DATA', name: '立地データ' },
  'trade-area-analysis': { pk: 'TRADE_AREA_ANALYSIS', name: '商圏分析結果' },
  'competitor-research': { pk: 'COMPETITOR_RESEARCH', name: '競合調査データ' },
  'candidate-locations': { pk: 'CANDIDATE_LOCATION', name: '候補地' },
  'population-statistics': { pk: 'POPULATION_STATISTICS', name: '人口統計データ' },
  'consumer-attributes': { pk: 'CONSUMER_ATTRIBUTES', name: '消費者属性情報' },
  'market-size-results': { pk: 'MARKET_SIZE_RESULT', name: '市場規模算出結果' },
  'competitor-salons': { pk: 'COMPETITOR_SALON', name: '競合サロン' },
  'analysis-reports': { pk: 'ANALYSIS_REPORT', name: '分析レポート' },
  'data-collection-history': { pk: 'DATA_COLLECTION_HISTORY', name: 'データ収集履歴' }
};

function getUserRole(event: APIGatewayEvent): Role {
  const role = event.headers['X-User-Role'] || event.headers['x-user-role'] || 'viewer';
  return validateRole(role) ? role : 'viewer';
}

function getUserId(event: APIGatewayEvent): string {
  return event.headers['X-User-Id'] || event.headers['x-user-id'] || 'anonymous';
}

async function createAuditLog(userId: string, action: string, details: any, ip: string, userAgent: string): Promise<void> {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId,
    action,
    details: JSON.stringify(details),
    ipAddress: ip,
    userAgent,
    timestamp: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };

  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

function createResponse(statusCode: number, body: any): APIGatewayResponse {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body)
  };
}

function parseTableFromPath(path: string): string | null {
  const match = path.match(/^\/api\/([^/]+)/);
  return match ? match[1] : null;
}

function getTableConfig(tableName: string) {
  return TABLE_CONFIGS[tableName as keyof typeof TABLE_CONFIGS];
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    if (event.path === '/resources') {
      return await handleResourcesEndpoint(event);
    }

    const tableName = parseTableFromPath(event.path);
    if (!tableName) {
      return createResponse(404, { error: 'Invalid path' });
    }

    const tableConfig = getTableConfig(tableName);
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }

    const role = getUserRole(event);
    const userId = getUserId(event);
    const ip = event.requestContext.identity.sourceIp;
    const userAgent = event.requestContext.identity.userAgent;

    if (event.path.includes('/bulk') && event.httpMethod === 'POST') {
      return await handleBulkImport(event, tableName, tableConfig, role, userId, ip, userAgent);
    }

    switch (event.httpMethod) {
      case 'GET':
        if (!hasPermission(role, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }
        return await handleGet(event, tableName, tableConfig, userId, ip, userAgent);
      
      case 'POST':
        if (!hasPermission(role, 'write')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }
        return await handlePost(event, tableName, tableConfig, userId, ip, userAgent);
      
      case 'PUT':
        if (!hasPermission(role, 'write')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }
        return await handlePut(event, tableName, tableConfig, userId, ip, userAgent);
      
      case 'DELETE':
        if (!hasPermission(role, 'delete')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }
        return await handleDelete(event, tableName, tableConfig, userId, ip, userAgent);
      
      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

async function handleResourcesEndpoint(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  const role = getUserRole(event);
  
  if (!hasPermission(role, 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  const resources = Object.entries(TABLE_CONFIGS).map(([key, config]) => ({
    id: key,
    name: config.name,
    type: config.pk
  }));

  return createResponse(200, { resources });
}

async function handleBulkImport(
  event: APIGatewayEvent,
  tableName: string,
  tableConfig: any,
  role: Role,
  userId: string,
  ip: string,
  userAgent: string
): Promise<APIGatewayResponse> {
  if (!hasPermission(role, 'write')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }

  let requestBody;
  try {
    requestBody = JSON.parse(event.body);
  } catch {
    return createResponse(400, { error: 'Invalid JSON in request body' });
  }

  if (!requestBody.items || !Array.isArray(requestBody.items)) {
    return createResponse(400, { error: 'items array is required' });
  }

  const items = requestBody.items;
  let imported = 0;
  let failed = 0;
  const errors: string[] = [];
  const now = new Date().toISOString();

  // Process items in batches of 25 (DynamoDB BatchWrite limit)
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    const putRequests = batch.map((item, index) => {
      try {
        const processedItem = {
          ...item,
          pk: tableConfig.pk,
          sk: item.id || item.sk || `${Date.now()}_${randomUUID()}`,
          id: item.id || randomUUID(),
          createdAt: item.createdAt || now,
          updatedAt: now,
          createdBy: item.createdBy || userId,
          updatedBy: userId
        };

        return {
          PutRequest: {
            Item: processedItem
          }
        };
      } catch (error) {
        failed++;
        errors.push(`Item ${i + index}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        return null;
      }
    }).filter(Boolean);

    if (putRequests.length > 0) {
      try {
        await docClient.send(new BatchWriteCommand({
          RequestItems: {
            [TABLE_NAME]: putRequests
          }
        }));
        imported += putRequests.length;
      } catch (error) {
        failed += putRequests.length;
        errors.push(`Batch ${Math.floor(i / 25)}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  }

  await createAuditLog(
    userId,
    'BULK_IMPORT',
    { tableName, totalItems: items.length, imported, failed },
    ip,
    userAgent
  );

  return createResponse(200, { imported, failed, errors });
}

async function handleGet(
  event: APIGatewayEvent,
  tableName: string,
  tableConfig: any,
  userId: string,
  ip: string,
  userAgent: string
): Promise<APIGatewayResponse> {
  const id = event.pathParameters?.id;

  if (id) {
    // Get single item
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: tableConfig.pk,
        sk: id
      }
    }));

    if (!result.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    await createAuditLog(
      userId,
      'READ_ITEM',
      { tableName, itemId: id },
      ip,
      userAgent
    );

    return createResponse(200, { item: result.Item });
  } else {
    // Get all items
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': tableConfig.pk
      }
    }));

    await createAuditLog(
      userId,
      'READ_LIST',
      { tableName, count: result.Items?.length || 0 },
      ip,
      userAgent
    );

    return createResponse(200, { items: result.Items || [] });
  }
}

async function handlePost(
  event: APIGatewayEvent,
  tableName: string,
  tableConfig: any,
  userId: string,
  ip: string,
  userAgent: string
): Promise<APIGatewayResponse> {
  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }

  let item;
  try {
    item = JSON.parse(event.body);
  } catch {
    return createResponse(400, { error: 'Invalid JSON in request body' });
  }

  const now = new Date().toISOString();
  const id = item.id || randomUUID();

  const newItem = {
    ...item,
    pk: tableConfig.pk,
    sk: id,
    id,
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
    updatedBy: userId
  };

  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: newItem
  }));

  await createAuditLog(
    userId,
    'CREATE_ITEM',
    { tableName, itemId: id, item: newItem },
    ip,
    userAgent
  );

  return createResponse(201, { item: newItem });
}

async function handlePut(
  event: APIGatewayEvent,
  tableName: string,
  tableConfig: any,
  userId: string,
  ip: string,
  userAgent: string
): Promise<APIGatewayResponse> {
  const id = event.pathParameters?.id;
  if (!id) {
    return createResponse(400, { error: 'ID is required' });
  }

  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }

  let updateData;
  try {
    updateData = JSON.parse(event.body);
  } catch {
    return createResponse(400, { error: 'Invalid JSON in request body' });
  }

  // Get existing item for audit log
  const existingResult = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: tableConfig.pk,
      sk: id
    }
  }));

  if (!existingResult.Item) {
    return createResponse(404, { error: 'Item not found' });
  }

  const updatedItem = {
    ...existingResult.Item,
    ...updateData,
    pk: tableConfig.pk,
    sk: id,
    id,
    updatedAt: new Date().toISOString(),
    updatedBy: userId
  };

  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: updatedItem
  }));

  await createAuditLog(
    userId,
    'UPDATE_ITEM',
    { tableName, itemId: id, before: existingResult.Item, after: updatedItem },
    ip,
    userAgent
  );

  return createResponse(200, { item: updatedItem });
}

async function handleDelete(
  event: APIGatewayEvent,
  tableName: string,
  tableConfig: any,
  userId: string,
  ip: string,
  userAgent: string
): Promise<APIGatewayResponse> {
  const id = event.pathParameters?.id;
  if (!id) {
    return createResponse(400, { error: 'ID is required' });
  }

  // Get existing item for audit log
  const existingResult = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: tableConfig.pk,
      sk: id
    }
  }));

  if (!existingResult.Item) {
    return createResponse(404, { error: 'Item not found' });
  }

  await docClient.send(new DeleteCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: tableConfig.pk,
      sk: id
    }
  }));

  await createAuditLog(
    userId,
    'DELETE_ITEM',
    { tableName, itemId: id, deletedItem: existingResult.Item },
    ip,
    userAgent
  );

  return createResponse(200, { message: 'Item deleted successfully' });
}