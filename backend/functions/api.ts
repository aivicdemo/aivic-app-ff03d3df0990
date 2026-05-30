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

function extractAuth(event: APIGatewayProxyEvent): AuthContext {
  const userId = event.headers['x-user-id'] || 'anonymous';
  const roleHeader = event.headers['x-user-role'] || 'viewer';
  const role = validateRole(roleHeader);
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

async function writeAuditLog(userId: string, action: string, details: any): Promise<void> {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${crypto.randomUUID()}`,
    userId,
    action,
    details,
    timestamp: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

function validateTableKey(tableKey: string): string {
  if (!TABLE_CONFIGS[tableKey as keyof typeof TABLE_CONFIGS]) {
    throw new Error('Invalid table key');
  }
  return tableKey;
}

function getTableConfig(tableKey: string) {
  return TABLE_CONFIGS[tableKey as keyof typeof TABLE_CONFIGS];
}

function addTimestamps(item: any, isUpdate = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const auth = extractAuth(event);
    const path = event.path;
    const method = event.httpMethod;

    // GET /resources エンドポイント
    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(auth.role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const resources = Object.entries(TABLE_CONFIGS).map(([key, config]) => ({
        key,
        name: config.name,
        pk: config.pk
      }));

      return createResponse(200, { resources });
    }

    // テーブル操作のパスパターンをチェック
    const tablePathMatch = path.match(/^\/api\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
    if (!tablePathMatch) {
      return createResponse(404, { error: 'Not found' });
    }

    const [, tableKey, action, id] = tablePathMatch;
    
    try {
      validateTableKey(tableKey);
    } catch {
      return createResponse(404, { error: 'Table not found' });
    }

    const tableConfig = getTableConfig(tableKey);

    // 一括インポート処理
    if (action === 'bulk' && method === 'POST') {
      if (!hasPermission(auth.role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const body = JSON.parse(event.body || '{}');
      if (!body.items || !Array.isArray(body.items)) {
        return createResponse(400, { error: 'Invalid request body. Expected { items: [] }' });
      }

      const items = body.items;
      let imported = 0;
      let failed = 0;
      const errors: string[] = [];

      // 25件ずつに分割してバッチ処理
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        const putRequests = batch.map(item => {
          const processedItem = {
            ...item,
            pk: tableConfig.pk,
            sk: item.id || crypto.randomUUID(),
            id: item.id || crypto.randomUUID(),
            ...addTimestamps(item, false),
            createdBy: auth.userId,
            updatedBy: auth.userId
          };
          return {
            PutRequest: {
              Item: processedItem
            }
          };
        });

        try {
          await docClient.send(new BatchWriteCommand({
            RequestItems: {
              [TABLE_NAME]: putRequests
            }
          }));
          imported += batch.length;
        } catch (error) {
          failed += batch.length;
          errors.push(`Batch ${Math.floor(i/25) + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      await writeAuditLog(auth.userId, 'BULK_IMPORT', {
        tableKey,
        totalItems: items.length,
        imported,
        failed
      });

      return createResponse(200, { imported, failed, errors });
    }

    // 一覧取得
    if (!action && method === 'GET') {
      if (!hasPermission(auth.role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const result = await docClient.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'pk = :pk',
        ExpressionAttributeValues: {
          ':pk': tableConfig.pk
        }
      }));

      return createResponse(200, { items: result.Items || [] });
    }

    // 詳細取得
    if (action && !id && method === 'GET') {
      if (!hasPermission(auth.role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: action
        }
      }));

      if (!result.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      return createResponse(200, { item: result.Item });
    }

    // 新規作成
    if (!action && method === 'POST') {
      if (!hasPermission(auth.role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const body = JSON.parse(event.body || '{}');
      const itemId = crypto.randomUUID();
      const item = {
        ...body,
        pk: tableConfig.pk,
        sk: itemId,
        id: itemId,
        ...addTimestamps(body, false),
        createdBy: auth.userId,
        updatedBy: auth.userId
      };

      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      }));

      await writeAuditLog(auth.userId, 'CREATE', {
        tableKey,
        itemId,
        item
      });

      return createResponse(201, { item });
    }

    // 更新
    if (action && method === 'PUT') {
      if (!hasPermission(auth.role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const body = JSON.parse(event.body || '{}');
      
      // 既存アイテムの取得
      const existingResult = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: action
        }
      }));

      if (!existingResult.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      const updatedItem = {
        ...existingResult.Item,
        ...body,
        pk: tableConfig.pk,
        sk: action,
        id: action,
        ...addTimestamps(body, true),
        updatedBy: auth.userId
      };

      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: updatedItem
      }));

      await writeAuditLog(auth.userId, 'UPDATE', {
        tableKey,
        itemId: action,
        oldItem: existingResult.Item,
        newItem: updatedItem
      });

      return createResponse(200, { item: updatedItem });
    }

    // 削除
    if (action && method === 'DELETE') {
      if (!hasPermission(auth.role, 'delete')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      // 削除前にアイテムを取得
      const existingResult = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: action
        }
      }));

      if (!existingResult.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      await docClient.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: action
        }
      }));

      await writeAuditLog(auth.userId, 'DELETE', {
        tableKey,
        itemId: action,
        deletedItem: existingResult.Item
      });

      return createResponse(200, { message: 'Item deleted successfully' });
    }

    return createResponse(404, { error: 'Not found' });

  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }
    
    if (error instanceof Error && error.message === 'Invalid role') {
      return createResponse(400, { error: 'Invalid role specified' });
    }
    
    return createResponse(500, { 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};