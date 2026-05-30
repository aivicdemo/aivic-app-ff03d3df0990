import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { getUserFromEvent, hasPermission } from './rbac';
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
}

interface APIGatewayResponse {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
};

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

async function createAuditLog(user: any, action: string, target: string, details: any) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}-${crypto.randomUUID()}`,
    userId: user.id,
    action,
    target,
    details: JSON.stringify(details),
    timestamp: new Date().toISOString(),
    ipAddress: 'unknown'
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

function validateTableKey(tableKey: string): boolean {
  return Object.keys(TABLE_CONFIGS).includes(tableKey);
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const user = getUserFromEvent(event);
    const path = event.path;
    const method = event.httpMethod;

    // GET /resources - リソース一覧取得
    if (method === 'GET' && path === '/resources') {
      if (!hasPermission(user, 'read:all')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const resources = Object.entries(TABLE_CONFIGS).map(([key, config]) => ({
        key,
        name: config.name,
        pk: config.pk
      }));

      return createResponse(200, { resources });
    }

    // テーブル操作のパスパターン解析
    const pathMatch = path.match(/^\/api\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
    if (!pathMatch) {
      return createResponse(404, { error: 'Invalid path' });
    }

    const [, tableKey, action, id] = pathMatch;

    if (!validateTableKey(tableKey)) {
      return createResponse(400, { error: 'Invalid table key' });
    }

    const tableConfig = TABLE_CONFIGS[tableKey as keyof typeof TABLE_CONFIGS];

    // 一括インポート処理
    if (method === 'POST' && action === 'bulk') {
      if (!hasPermission(user, 'bulk:import')) {
        return createResponse(403, { error: 'Insufficient permissions for bulk import' });
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
        const putRequests = batch.map(item => {
          const now = new Date().toISOString();
          return {
            PutRequest: {
              Item: {
                pk: tableConfig.pk,
                sk: item.id || crypto.randomUUID(),
                ...item,
                createdAt: now,
                updatedAt: now,
                createdBy: user.id,
                updatedBy: user.id
              }
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
          errors.push(`Batch ${Math.floor(i/25) + 1}: ${error}`);
        }
      }

      await createAuditLog(user, 'BULK_IMPORT', tableKey, {
        imported,
        failed,
        totalItems: items.length
      });

      return createResponse(200, { imported, failed, errors });
    }

    // 一覧取得
    if (method === 'GET' && !action) {
      if (!hasPermission(user, 'read:all')) {
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
    if (method === 'GET' && action && !id) {
      if (!hasPermission(user, 'read:all')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const command = new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: action
        }
      });

      const result = await docClient.send(command);
      if (!result.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      return createResponse(200, { item: result.Item });
    }

    // 新規作成
    if (method === 'POST' && !action) {
      if (!hasPermission(user, 'write:all')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const body = JSON.parse(event.body || '{}');
      const now = new Date().toISOString();
      const itemId = body.id || crypto.randomUUID();

      const item = {
        pk: tableConfig.pk,
        sk: itemId,
        ...body,
        id: itemId,
        createdAt: now,
        updatedAt: now,
        createdBy: user.id,
        updatedBy: user.id
      };

      const command = new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      });

      await docClient.send(command);
      await createAuditLog(user, 'CREATE', tableKey, { itemId });

      return createResponse(201, { item });
    }

    // 更新
    if (method === 'PUT' && action) {
      if (!hasPermission(user, 'write:all')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const body = JSON.parse(event.body || '{}');
      const now = new Date().toISOString();

      // 既存アイテムの取得
      const getCommand = new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: action
        }
      });

      const existingResult = await docClient.send(getCommand);
      if (!existingResult.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      const updatedItem = {
        ...existingResult.Item,
        ...body,
        updatedAt: now,
        updatedBy: user.id
      };

      const putCommand = new PutCommand({
        TableName: TABLE_NAME,
        Item: updatedItem
      });

      await docClient.send(putCommand);
      await createAuditLog(user, 'UPDATE', tableKey, { itemId: action });

      return createResponse(200, { item: updatedItem });
    }

    // 削除
    if (method === 'DELETE' && action) {
      if (!hasPermission(user, 'delete:all')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const command = new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: action
        }
      });

      await docClient.send(command);
      await createAuditLog(user, 'DELETE', tableKey, { itemId: action });

      return createResponse(200, { message: 'Item deleted successfully' });
    }

    return createResponse(404, { error: 'Endpoint not found' });

  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof Error) {
      if (error.message.includes('authorization')) {
        return createResponse(401, { error: 'Unauthorized' });
      }
      if (error.message.includes('ValidationException')) {
        return createResponse(400, { error: 'Invalid request data' });
      }
    }

    return createResponse(500, { error: 'Internal server error' });
  }
};