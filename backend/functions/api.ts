import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
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

const TABLE_CONFIGS = {
  '0': { name: 'ログインユーザー', pk: 'USER', sk: 'userId' },
  '1': { name: '店舗', pk: 'STORE', sk: 'storeId' },
  '2': { name: '売上データ', pk: 'SALES', sk: 'salesId' },
  '3': { name: '操作履歴', pk: 'AUDIT', sk: 'auditId' },
  '4': { name: '立地データ', pk: 'LOCATION', sk: 'locationId' },
  '5': { name: '商圏分析結果', pk: 'TRADE_AREA', sk: 'tradeAreaId' },
  '6': { name: '競合調査データ', pk: 'COMPETITOR_SURVEY', sk: 'competitorSurveyId' },
  '7': { name: '候補地', pk: 'CANDIDATE', sk: 'candidateId' },
  '8': { name: '人口統計データ', pk: 'POPULATION', sk: 'populationId' },
  '9': { name: '消費者属性情報', pk: 'CONSUMER', sk: 'consumerId' },
  '10': { name: '市場規模算出結果', pk: 'MARKET_SIZE', sk: 'marketSizeId' },
  '11': { name: '競合サロン', pk: 'COMPETITOR_SALON', sk: 'competitorSalonId' },
  '12': { name: '分析レポート', pk: 'REPORT', sk: 'reportId' },
  '13': { name: 'データ収集履歴', pk: 'DATA_COLLECTION', sk: 'dataCollectionId' }
};

function createResponse(statusCode: number, body: any): APIGatewayResponse {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    },
    body: JSON.stringify(body)
  };
}

function getUserRole(event: APIGatewayEvent): Role {
  const authHeader = event.headers.Authorization || event.headers.authorization;
  if (!authHeader) return 'viewer';
  
  const role = authHeader.replace('Bearer ', '');
  return validateRole(role) ? role : 'viewer';
}

function getCurrentTimestamp(): string {
  return new Date().toISOString();
}

function generateId(): string {
  return crypto.randomUUID();
}

async function createAuditLog(userId: string, action: string, targetTable: string, targetId: string, details: any, ip: string, userAgent: string): Promise<void> {
  const auditLog = {
    pk: 'AUDIT',
    sk: generateId(),
    auditId: generateId(),
    userId: userId || 'system',
    userName: 'System User',
    storeId: null,
    operationType: action,
    targetTable,
    targetId,
    operationContent: JSON.stringify(details),
    beforeData: null,
    afterData: JSON.stringify(details),
    ipAddress: ip,
    userAgent,
    operationResult: 'success',
    errorMessage: null,
    sessionId: generateId(),
    operationDateTime: getCurrentTimestamp(),
    createdAt: getCurrentTimestamp(),
    updatedAt: getCurrentTimestamp()
  };

  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

function validateResourcesPath(path: string): boolean {
  return path === '/resources';
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  try {
    const method = event.httpMethod;
    const path = event.path;
    const role = getUserRole(event);
    const ip = event.requestContext.identity.sourceIp;
    const userAgent = event.requestContext.identity.userAgent;

    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    // GET /resources エンドポイント
    if (method === 'GET' && validateResourcesPath(path)) {
      if (!hasPermission(role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      try {
        const resources = [];
        
        // 全テーブルからデータを取得
        for (const [tableIndex, config] of Object.entries(TABLE_CONFIGS)) {
          const command = new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: {
              ':pk': config.pk
            }
          });
          
          const result = await docClient.send(command);
          resources.push({
            tableIndex: parseInt(tableIndex),
            tableName: config.name,
            pk: config.pk,
            count: result.Items?.length || 0,
            items: result.Items || []
          });
        }

        return createResponse(200, { resources });
      } catch (error) {
        console.error('Error fetching resources:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // 一括インポートエンドポイント: POST /api/{tableIndex}/bulk
    const bulkImportMatch = path.match(/^\/api\/(\d+)\/bulk$/);
    if (method === 'POST' && bulkImportMatch) {
      const tableIndex = bulkImportMatch[1];
      const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      if (!config) {
        return createResponse(404, { error: 'Table not found' });
      }

      if (!hasPermission(role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions for bulk import' });
      }

      try {
        const body = JSON.parse(event.body || '{}');
        const items = body.items;
        
        if (!Array.isArray(items)) {
          return createResponse(400, { error: 'Items must be an array' });
        }

        let imported = 0;
        let failed = 0;
        const errors: string[] = [];
        const timestamp = getCurrentTimestamp();

        // 25件ずつに分割してバッチ処理
        const chunks = chunkArray(items, 25);
        
        for (const chunk of chunks) {
          const writeRequests = chunk.map(item => {
            const id = item.id || generateId();
            const processedItem = {
              ...item,
              pk: config.pk,
              sk: id,
              [config.sk]: id,
              createdAt: timestamp,
              updatedAt: timestamp
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
                [TABLE_NAME]: writeRequests
              }
            }));
            imported += chunk.length;
          } catch (error) {
            failed += chunk.length;
            errors.push(`Batch write failed: ${error}`);
          }
        }

        // 監査ログ記録
        await createAuditLog(
          'system',
          'bulk_import',
          config.name,
          config.pk,
          { imported, failed, tableIndex },
          ip,
          userAgent
        );

        return createResponse(200, { imported, failed, errors });
      } catch (error) {
        console.error('Bulk import error:', error);
        return createResponse(500, { error: 'Internal server error during bulk import' });
      }
    }

    // 個別テーブル操作エンドポイント: /api/{tableIndex}
    const tableMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?$/);
    if (tableMatch) {
      const tableIndex = tableMatch[1];
      const itemId = tableMatch[2];
      const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      if (!config) {
        return createResponse(404, { error: 'Table not found' });
      }

      switch (method) {
        case 'GET':
          if (!hasPermission(role, 'read')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          if (itemId) {
            // 詳細取得
            const command = new GetCommand({
              TableName: TABLE_NAME,
              Key: { pk: config.pk, sk: itemId }
            });
            
            const result = await docClient.send(command);
            if (!result.Item) {
              return createResponse(404, { error: 'Item not found' });
            }
            
            return createResponse(200, result.Item);
          } else {
            // 一覧取得
            const command = new ScanCommand({
              TableName: TABLE_NAME,
              FilterExpression: 'pk = :pk',
              ExpressionAttributeValues: {
                ':pk': config.pk
              }
            });
            
            const result = await docClient.send(command);
            return createResponse(200, { items: result.Items || [] });
          }

        case 'POST':
          if (!hasPermission(role, 'write')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          const createBody = JSON.parse(event.body || '{}');
          const newId = generateId();
          const timestamp = getCurrentTimestamp();
          
          const newItem = {
            ...createBody,
            pk: config.pk,
            sk: newId,
            [config.sk]: newId,
            createdAt: timestamp,
            updatedAt: timestamp
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: newItem
          }));

          await createAuditLog(
            'system',
            'create',
            config.name,
            newId,
            newItem,
            ip,
            userAgent
          );

          return createResponse(201, newItem);

        case 'PUT':
          if (!itemId) {
            return createResponse(400, { error: 'Item ID required for update' });
          }
          
          if (!hasPermission(role, 'write')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          const updateBody = JSON.parse(event.body || '{}');
          const updatedItem = {
            ...updateBody,
            pk: config.pk,
            sk: itemId,
            [config.sk]: itemId,
            updatedAt: getCurrentTimestamp()
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          }));

          await createAuditLog(
            'system',
            'update',
            config.name,
            itemId,
            updatedItem,
            ip,
            userAgent
          );

          return createResponse(200, updatedItem);

        case 'DELETE':
          if (!itemId) {
            return createResponse(400, { error: 'Item ID required for delete' });
          }
          
          if (!hasPermission(role, 'delete')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { pk: config.pk, sk: itemId }
          }));

          await createAuditLog(
            'system',
            'delete',
            config.name,
            itemId,
            { deleted: true },
            ip,
            userAgent
          );

          return createResponse(200, { message: 'Item deleted successfully' });

        default:
          return createResponse(405, { error: 'Method not allowed' });
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};