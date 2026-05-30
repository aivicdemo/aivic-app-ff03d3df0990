import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { hasPermission, validateRole, Role } from './rbac';
import * as crypto from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface AuthContext {
  userId: string;
  role: Role;
}

const TABLE_CONFIGS = {
  '0': { pk: 'LOGIN_USER', name: 'ログインユーザー' },
  '1': { pk: 'STORE', name: '店舗' },
  '2': { pk: 'SALES_DATA', name: '売上データ' },
  '3': { pk: 'OPERATION_HISTORY', name: '操作履歴' },
  '4': { pk: 'LOCATION_DATA', name: '立地データ' },
  '5': { pk: 'TRADE_AREA_ANALYSIS', name: '商圏分析結果' },
  '6': { pk: 'COMPETITOR_SURVEY', name: '競合調査データ' },
  '7': { pk: 'CANDIDATE_LOCATION', name: '候補地' },
  '8': { pk: 'POPULATION_STATS', name: '人口統計データ' },
  '9': { pk: 'CONSUMER_ATTRIBUTES', name: '消費者属性情報' },
  '10': { pk: 'MARKET_SIZE_RESULT', name: '市場規模算出結果' },
  '11': { pk: 'COMPETITOR_SALON', name: '競合サロン' },
  '12': { pk: 'ANALYSIS_REPORT', name: '分析レポート' },
  '13': { pk: 'DATA_COLLECTION_HISTORY', name: 'データ収集履歴' }
};

function getAuthContext(event: APIGatewayProxyEvent): AuthContext {
  const userId = event.headers['x-user-id'] || 'system';
  const role = event.headers['x-user-role'] || 'viewer';
  
  if (!validateRole(role)) {
    throw new Error('Invalid role');
  }
  
  return { userId, role };
}

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-user-id, x-user-role'
    },
    body: JSON.stringify(body)
  };
}

async function createAuditLog(userId: string, action: string, details: any) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${crypto.randomUUID()}`,
    userId,
    action,
    details,
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

function addTimestamps(item: any, userId: string, isUpdate = false) {
  const now = new Date().toISOString();
  
  if (!isUpdate) {
    item.createdAt = now;
    item.createdBy = userId;
  }
  
  item.updatedAt = now;
  item.updatedBy = userId;
  
  return item;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const auth = getAuthContext(event);
    const path = event.path;
    const method = event.httpMethod;
    
    // GET /resources エンドポイント
    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(auth.role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }
      
      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index,
        pk: config.pk,
        name: config.name
      }));
      
      return createResponse(200, { resources });
    }
    
    // テーブル操作エンドポイント
    const tableMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(\w+))?$/);
    if (!tableMatch) {
      return createResponse(404, { error: 'Endpoint not found' });
    }
    
    const [, tableIndex, operation, itemId] = tableMatch;
    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }
    
    // 一括インポートエンドポイント
    if (operation === 'bulk' && method === 'POST') {
      if (!hasPermission(auth.role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }
      
      const body = JSON.parse(event.body || '{}');
      const items = body.items || [];
      
      if (!Array.isArray(items)) {
        return createResponse(400, { error: 'Items must be an array' });
      }
      
      let imported = 0;
      let failed = 0;
      const errors: string[] = [];
      
      // 25件ずつに分割してバッチ処理
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        const writeRequests = batch.map(item => {
          const processedItem = {
            ...item,
            pk: tableConfig.pk,
            sk: item.id || crypto.randomUUID(),
            id: item.id || crypto.randomUUID()
          };
          
          addTimestamps(processedItem, auth.userId);
          
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
      
      await createAuditLog(auth.userId, 'BULK_IMPORT', {
        table: tableConfig.name,
        imported,
        failed,
        total: items.length
      });
      
      return createResponse(200, { imported, failed, errors });
    }
    
    // 一覧取得
    if (!operation && method === 'GET') {
      if (!hasPermission(auth.role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }
      
      const command = new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'pk = :pk',
        ExpressionAttributeValues: {
          ':pk': tableConfig.pk
        }
      });
      
      const result = await docClient.send(command);
      return createResponse(200, { items: result.Items || [] });
    }
    
    // 詳細取得
    if (itemId && method === 'GET') {
      if (!hasPermission(auth.role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }
      
      const command = new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: itemId
        }
      });
      
      const result = await docClient.send(command);
      
      if (!result.Item) {
        return createResponse(404, { error: 'Item not found' });
      }
      
      return createResponse(200, result.Item);
    }
    
    // 新規作成
    if (!itemId && method === 'POST') {
      if (!hasPermission(auth.role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }
      
      const body = JSON.parse(event.body || '{}');
      const id = crypto.randomUUID();
      
      const item = {
        ...body,
        pk: tableConfig.pk,
        sk: id,
        id
      };
      
      addTimestamps(item, auth.userId);
      
      const command = new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      });
      
      await docClient.send(command);
      await createAuditLog(auth.userId, 'CREATE', { table: tableConfig.name, id });
      
      return createResponse(201, item);
    }
    
    // 更新
    if (itemId && method === 'PUT') {
      if (!hasPermission(auth.role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }
      
      const body = JSON.parse(event.body || '{}');
      
      // 既存アイテムの確認
      const getCommand = new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: itemId
        }
      });
      
      const existingResult = await docClient.send(getCommand);
      
      if (!existingResult.Item) {
        return createResponse(404, { error: 'Item not found' });
      }
      
      const updatedItem = {
        ...existingResult.Item,
        ...body,
        pk: tableConfig.pk,
        sk: itemId,
        id: itemId
      };
      
      addTimestamps(updatedItem, auth.userId, true);
      
      const putCommand = new PutCommand({
        TableName: TABLE_NAME,
        Item: updatedItem
      });
      
      await docClient.send(putCommand);
      await createAuditLog(auth.userId, 'UPDATE', { table: tableConfig.name, id: itemId });
      
      return createResponse(200, updatedItem);
    }
    
    // 削除
    if (itemId && method === 'DELETE') {
      if (!hasPermission(auth.role, 'delete')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }
      
      // 既存アイテムの確認
      const getCommand = new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: itemId
        }
      });
      
      const existingResult = await docClient.send(getCommand);
      
      if (!existingResult.Item) {
        return createResponse(404, { error: 'Item not found' });
      }
      
      const deleteCommand = new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: itemId
        }
      });
      
      await docClient.send(deleteCommand);
      await createAuditLog(auth.userId, 'DELETE', { table: tableConfig.name, id: itemId });
      
      return createResponse(200, { message: 'Item deleted successfully' });
    }
    
    return createResponse(405, { error: 'Method not allowed' });
    
  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof Error && error.message === 'Invalid role') {
      return createResponse(403, { error: 'Invalid role' });
    }
    
    return createResponse(500, { 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};