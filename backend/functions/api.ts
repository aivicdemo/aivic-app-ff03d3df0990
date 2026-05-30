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
  pathParameters?: { [key: string]: string } | null;
  queryStringParameters?: { [key: string]: string } | null;
  headers?: { [key: string]: string };
  body?: string | null;
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

function createResponse(statusCode: number, body: any, headers: { [key: string]: string } = {}): APIGatewayResponse {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      ...headers
    },
    body: JSON.stringify(body)
  };
}

function getUserRole(event: APIGatewayEvent): Role {
  const authHeader = event.headers?.['Authorization'] || event.headers?.['authorization'];
  if (!authHeader) return 'viewer';
  
  const token = authHeader.replace('Bearer ', '');
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    const role = payload.role || 'viewer';
    return validateRole(role) ? role : 'viewer';
  } catch {
    return 'viewer';
  }
}

async function createAuditLog(action: string, details: any, userId: string = 'system') {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${crypto.randomUUID()}`,
    action,
    details,
    userId,
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

function getTableKeyFromPath(path: string): string | null {
  const match = path.match(/^\/api\/([^/]+)/);
  return match ? match[1] : null;
}

function validateRequiredFields(item: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (!item[field]) {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function getRequiredFields(tableKey: string): string[] {
  const fieldMap: { [key: string]: string[] } = {
    'login-users': ['ログインID', 'パスワードハッシュ', 'ユーザー名', 'メールアドレス', '権限レベル', 'アクティブフラグ', '作成者', '更新者'],
    'stores': ['店舗コード', '店舗名', '店舗区分', '営業状態', '有効フラグ', '作成者ID', '更新者ID'],
    'sales-data': ['店舗ID', 'POSレジID', '売上日', '売上金額', '税抜金額', '消費税額', '取引番号', '支払方法', '客数', '商品点数', '売上区分', '営業日', 'データ連携状態', '作成者'],
    'operation-history': ['ユーザーID', 'ユーザー名', '操作種別', '操作内容', 'IPアドレス', '操作結果', '操作日時'],
    'location-data': ['立地名', '都道府県', '市区町村', '住所', '立地種別', 'ステータス', '作成者', '更新者'],
    'trade-area-analysis': ['店舗ID', '分析名称', '分析種別', '商圏半径', '分析ステータス', '分析実行日時', '作成者ID'],
    'competitor-research': ['調査対象店舗名', '競合企業名', '店舗住所', '業態', '調査日', '調査方法', '調査者', 'ステータス', '作成者', '更新者'],
    'candidate-locations': ['候補地名', '都道府県', '市区町村', '住所', '物件種別', '検討ステータス', '優先度', '担当者ID', '作成者ID', '更新者ID'],
    'demographic-data': ['地域コード', '地域名', '統計年度', '総人口', '世帯数', 'データソース', '有効フラグ', '作成者', '更新者'],
    'consumer-attributes': ['商圏ID', '年齢層区分', '性別', '世帯年収区分', '職業分類', '世帯構成', '人数', '構成比率', 'データ取得年月', 'データソース', '作成者ID'],
    'market-size-results': ['算出名称', '算出対象エリア', '算出手法', '総市場規模', '対象人口', '算出基準年月', 'ステータス', '作成者ID'],
    'competitor-salons': ['サロン名', '住所', '営業状態', '競合レベル', '調査ステータス', '作成者ID', '更新者ID'],
    'analysis-reports': ['レポート名', 'レポート種別', '分析期間開始日', '分析期間終了日', 'レポート内容', '結論サマリー', 'ステータス', '優先度', '公開フラグ', '作成者ID'],
    'data-collection-history': ['データソース種別', 'データソース名', '収集開始日時', '収集ステータス', '収集方法', '作成者ID']
  };
  return fieldMap[tableKey] || [];
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const userRole = getUserRole(event);
    const path = event.path;
    const method = event.httpMethod;

    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(userRole, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      try {
        const resources = {
          tables: Object.keys(TABLE_CONFIGS),
          userRole,
          permissions: {
            read: hasPermission(userRole, 'read'),
            write: hasPermission(userRole, 'write'),
            delete: hasPermission(userRole, 'delete')
          }
        };
        return createResponse(200, resources);
      } catch (error) {
        console.error('Error fetching resources:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    const tableKey = getTableKeyFromPath(path);
    if (!tableKey || !TABLE_CONFIGS[tableKey]) {
      return createResponse(404, { error: 'Table not found' });
    }

    const tableConfig = TABLE_CONFIGS[tableKey];
    const pathParts = path.split('/');

    if (pathParts.length >= 4 && pathParts[3] === 'bulk' && method === 'POST') {
      if (!hasPermission(userRole, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions for bulk import' });
      }

      try {
        const body = JSON.parse(event.body || '{}');
        const items = body.items || [];
        
        if (!Array.isArray(items)) {
          return createResponse(400, { error: 'Items must be an array' });
        }

        let imported = 0;
        let failed = 0;
        const errors: string[] = [];
        const requiredFields = getRequiredFields(tableKey);
        const now = new Date().toISOString();

        const batches = [];
        for (let i = 0; i < items.length; i += 25) {
          batches.push(items.slice(i, i + 25));
        }

        for (const batch of batches) {
          const writeRequests = [];
          
          for (const item of batch) {
            const validationErrors = validateRequiredFields(item, requiredFields);
            if (validationErrors.length > 0) {
              failed++;
              errors.push(`Item validation failed: ${validationErrors.join(', ')}`);
              continue;
            }

            const id = item.id || crypto.randomUUID();
            const enrichedItem = {
              ...item,
              pk: tableConfig.pk,
              sk: id,
              id,
              createdAt: now,
              updatedAt: now
            };

            writeRequests.push({
              PutRequest: {
                Item: enrichedItem
              }
            });
          }

          if (writeRequests.length > 0) {
            try {
              await docClient.send(new BatchWriteCommand({
                RequestItems: {
                  [TABLE_NAME]: writeRequests
                }
              }));
              imported += writeRequests.length;
            } catch (error) {
              failed += writeRequests.length;
              errors.push(`Batch write failed: ${error}`);
            }
          }
        }

        await createAuditLog('BULK_IMPORT', {
          table: tableConfig.name,
          imported,
          failed,
          totalItems: items.length
        });

        return createResponse(200, { imported, failed, errors });
      } catch (error) {
        console.error('Bulk import error:', error);
        return createResponse(500, { error: 'Internal server error during bulk import' });
      }
    }

    if (method === 'GET' && pathParts.length === 3) {
      if (!hasPermission(userRole, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      try {
        const result = await docClient.send(new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: 'pk = :pk',
          ExpressionAttributeValues: {
            ':pk': tableConfig.pk
          }
        }));
        return createResponse(200, { items: result.Items || [] });
      } catch (error) {
        console.error('Scan error:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    if (method === 'GET' && pathParts.length === 4) {
      if (!hasPermission(userRole, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const id = pathParts[3];
      try {
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
        
        return createResponse(200, result.Item);
      } catch (error) {
        console.error('Get error:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    if (method === 'POST' && pathParts.length === 3) {
      if (!hasPermission(userRole, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      try {
        const body = JSON.parse(event.body || '{}');
        const requiredFields = getRequiredFields(tableKey);
        const validationErrors = validateRequiredFields(body, requiredFields);
        
        if (validationErrors.length > 0) {
          return createResponse(400, { error: 'Validation failed', details: validationErrors });
        }

        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const item = {
          ...body,
          pk: tableConfig.pk,
          sk: id,
          id,
          createdAt: now,
          updatedAt: now
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        }));

        await createAuditLog('CREATE', {
          table: tableConfig.name,
          itemId: id,
          data: item
        });

        return createResponse(201, item);
      } catch (error) {
        console.error('Create error:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    if (method === 'PUT' && pathParts.length === 4) {
      if (!hasPermission(userRole, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const id = pathParts[3];
      try {
        const body = JSON.parse(event.body || '{}');
        const requiredFields = getRequiredFields(tableKey);
        const validationErrors = validateRequiredFields(body, requiredFields);
        
        if (validationErrors.length > 0) {
          return createResponse(400, { error: 'Validation failed', details: validationErrors });
        }

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

        const item = {
          ...body,
          pk: tableConfig.pk,
          sk: id,
          id,
          createdAt: existingResult.Item.createdAt,
          updatedAt: new Date().toISOString()
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        }));

        await createAuditLog('UPDATE', {
          table: tableConfig.name,
          itemId: id,
          oldData: existingResult.Item,
          newData: item
        });

        return createResponse(200, item);
      } catch (error) {
        console.error('Update error:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    if (method === 'DELETE' && pathParts.length === 4) {
      if (!hasPermission(userRole, 'delete')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const id = pathParts[3];
      try {
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

        await createAuditLog('DELETE', {
          table: tableConfig.name,
          itemId: id,
          deletedData: existingResult.Item
        });

        return createResponse(200, { message: 'Item deleted successfully' });
      } catch (error) {
        console.error('Delete error:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};