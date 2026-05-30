import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { hasPermission, validateRole, Role } from './rbac';
import * as crypto from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface ResourceItem {
  pk: string;
  sk: string;
  id: string;
  type: string;
  [key: string]: any;
}

const TABLE_CONFIGS = {
  '0': { type: 'LOGIN_USER', name: 'ログインユーザー' },
  '1': { type: 'STORE', name: '店舗' },
  '2': { type: 'SALES_DATA', name: '売上データ' },
  '3': { type: 'OPERATION_HISTORY', name: '操作履歴' },
  '4': { type: 'LOCATION_DATA', name: '立地データ' },
  '5': { type: 'TRADE_AREA_ANALYSIS', name: '商圏分析結果' },
  '6': { type: 'COMPETITOR_SURVEY', name: '競合調査データ' },
  '7': { type: 'CANDIDATE_LOCATION', name: '候補地' },
  '8': { type: 'POPULATION_STATS', name: '人口統計データ' },
  '9': { type: 'CONSUMER_ATTRIBUTES', name: '消費者属性情報' },
  '10': { type: 'MARKET_SIZE_RESULT', name: '市場規模算出結果' },
  '11': { type: 'COMPETITOR_SALON', name: '競合サロン' },
  '12': { type: 'ANALYSIS_REPORT', name: '分析レポート' },
  '13': { type: 'DATA_COLLECTION_HISTORY', name: 'データ収集履歴' }
};

function getUserRole(event: APIGatewayProxyEvent): Role {
  const role = event.headers['x-user-role'] || event.headers['X-User-Role'] || 'viewer';
  return validateRole(role);
}

function getUserId(event: APIGatewayProxyEvent): string {
  return event.headers['x-user-id'] || event.headers['X-User-Id'] || 'system';
}

async function createAuditLog(userId: string, action: string, details: any): Promise<void> {
  const auditItem = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${crypto.randomUUID()}`,
    id: crypto.randomUUID(),
    userId,
    action,
    details: JSON.stringify(details),
    timestamp: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditItem
  }));
}

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Role, X-User-Id'
    },
    body: JSON.stringify(body)
  };
}

function validateTableIndex(tableIndex: string): string {
  if (!TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS]) {
    throw new Error('Invalid table index');
  }
  return tableIndex;
}

function generateId(): string {
  return crypto.randomUUID();
}

function addTimestamps(item: any, isUpdate: boolean = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

async function handleGetResources(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const role = getUserRole(event);
    
    if (!hasPermission(role, 'read')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    const pathParts = event.path.split('/');
    const tableIndex = pathParts[2];
    const itemId = pathParts[3];
    
    if (!tableIndex) {
      return createResponse(400, { error: 'Table index is required' });
    }
    
    validateTableIndex(tableIndex);
    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    if (itemId) {
      // 詳細取得
      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: config.type,
          sk: itemId
        }
      }));
      
      if (!result.Item) {
        return createResponse(404, { error: 'Item not found' });
      }
      
      return createResponse(200, result.Item);
    } else {
      // 一覧取得
      const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 100;
      const lastKey = event.queryStringParameters?.lastKey;
      
      const scanParams: any = {
        TableName: TABLE_NAME,
        FilterExpression: '#type = :type',
        ExpressionAttributeNames: {
          '#type': 'pk'
        },
        ExpressionAttributeValues: {
          ':type': config.type
        },
        Limit: Math.min(limit, 1000)
      };
      
      if (lastKey) {
        try {
          scanParams.ExclusiveStartKey = JSON.parse(decodeURIComponent(lastKey));
        } catch (e) {
          return createResponse(400, { error: 'Invalid lastKey format' });
        }
      }
      
      const result = await docClient.send(new ScanCommand(scanParams));
      
      return createResponse(200, {
        items: result.Items || [],
        lastKey: result.LastEvaluatedKey ? encodeURIComponent(JSON.stringify(result.LastEvaluatedKey)) : null,
        count: result.Count || 0
      });
    }
  } catch (error) {
    console.error('Error in handleGetResources:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handlePostResource(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const role = getUserRole(event);
    const userId = getUserId(event);
    
    if (!hasPermission(role, 'write')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    const pathParts = event.path.split('/');
    const tableIndex = pathParts[2];
    const isBulk = pathParts[3] === 'bulk';
    
    if (!tableIndex) {
      return createResponse(400, { error: 'Table index is required' });
    }
    
    validateTableIndex(tableIndex);
    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    if (!event.body) {
      return createResponse(400, { error: 'Request body is required' });
    }
    
    const requestBody = JSON.parse(event.body);
    
    if (isBulk) {
      // 一括インポート
      if (!requestBody.items || !Array.isArray(requestBody.items)) {
        return createResponse(400, { error: 'items array is required for bulk import' });
      }
      
      const items = requestBody.items;
      let imported = 0;
      let failed = 0;
      const errors: string[] = [];
      
      // 25件ずつに分割してバッチ処理
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        const writeRequests = batch.map(item => {
          const id = generateId();
          const processedItem = addTimestamps({
            ...item,
            pk: config.type,
            sk: id,
            id,
            type: config.type,
            createdBy: userId,
            updatedBy: userId
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
          imported += batch.length;
        } catch (error) {
          failed += batch.length;
          errors.push(`Batch ${Math.floor(i/25) + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
      
      await createAuditLog(userId, 'BULK_IMPORT', {
        tableType: config.type,
        imported,
        failed,
        totalItems: items.length
      });
      
      return createResponse(200, { imported, failed, errors });
    } else {
      // 単一アイテム作成
      const id = generateId();
      const item = addTimestamps({
        ...requestBody,
        pk: config.type,
        sk: id,
        id,
        type: config.type,
        createdBy: userId,
        updatedBy: userId
      });
      
      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      }));
      
      await createAuditLog(userId, 'CREATE', {
        tableType: config.type,
        itemId: id
      });
      
      return createResponse(201, item);
    }
  } catch (error) {
    console.error('Error in handlePostResource:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handlePutResource(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const role = getUserRole(event);
    const userId = getUserId(event);
    
    if (!hasPermission(role, 'write')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    const pathParts = event.path.split('/');
    const tableIndex = pathParts[2];
    const itemId = pathParts[3];
    
    if (!tableIndex || !itemId) {
      return createResponse(400, { error: 'Table index and item ID are required' });
    }
    
    validateTableIndex(tableIndex);
    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    if (!event.body) {
      return createResponse(400, { error: 'Request body is required' });
    }
    
    const requestBody = JSON.parse(event.body);
    
    // 既存アイテムの確認
    const existingItem = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.type,
        sk: itemId
      }
    }));
    
    if (!existingItem.Item) {
      return createResponse(404, { error: 'Item not found' });
    }
    
    const updatedItem = addTimestamps({
      ...existingItem.Item,
      ...requestBody,
      pk: config.type,
      sk: itemId,
      id: itemId,
      type: config.type,
      updatedBy: userId
    }, true);
    
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedItem
    }));
    
    await createAuditLog(userId, 'UPDATE', {
      tableType: config.type,
      itemId,
      changes: requestBody
    });
    
    return createResponse(200, updatedItem);
  } catch (error) {
    console.error('Error in handlePutResource:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDeleteResource(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const role = getUserRole(event);
    const userId = getUserId(event);
    
    if (!hasPermission(role, 'delete')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    const pathParts = event.path.split('/');
    const tableIndex = pathParts[2];
    const itemId = pathParts[3];
    
    if (!tableIndex || !itemId) {
      return createResponse(400, { error: 'Table index and item ID are required' });
    }
    
    validateTableIndex(tableIndex);
    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    // 既存アイテムの確認
    const existingItem = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.type,
        sk: itemId
      }
    }));
    
    if (!existingItem.Item) {
      return createResponse(404, { error: 'Item not found' });
    }
    
    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.type,
        sk: itemId
      }
    }));
    
    await createAuditLog(userId, 'DELETE', {
      tableType: config.type,
      itemId,
      deletedItem: existingItem.Item
    });
    
    return createResponse(200, { message: 'Item deleted successfully' });
  } catch (error) {
    console.error('Error in handleDeleteResource:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }
    
    const path = event.path;
    
    if (path === '/resources' && event.httpMethod === 'GET') {
      // 全テーブル一覧
      const role = getUserRole(event);
      if (!hasPermission(role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }
      
      return createResponse(200, {
        tables: Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
          index,
          type: config.type,
          name: config.name
        }))
      });
    }
    
    if (path.startsWith('/api/')) {
      switch (event.httpMethod) {
        case 'GET':
          return await handleGetResources(event);
        case 'POST':
          return await handlePostResource(event);
        case 'PUT':
          return await handlePutResource(event);
        case 'DELETE':
          return await handleDeleteResource(event);
        default:
          return createResponse(405, { error: 'Method not allowed' });
      }
    }
    
    return createResponse(404, { error: 'Not found' });
  } catch (error) {
    console.error('Error in handler:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};