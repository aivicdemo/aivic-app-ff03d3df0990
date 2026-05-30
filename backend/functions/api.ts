import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, DeleteCommand, UpdateCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, validateRole, Role } from './rbac';
import crypto from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

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
  headers: { [key: string]: string };
  body: string;
}

const TABLE_CONFIGS = {
  '0': { pk: 'USER', name: 'ログインユーザー' },
  '1': { pk: 'STORE', name: '店舗' },
  '2': { pk: 'SALES', name: '売上データ' },
  '3': { pk: 'OPERATION_LOG', name: '操作履歴' },
  '4': { pk: 'LOCATION', name: '立地データ' },
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
  const authHeader = event.headers?.['Authorization'] || event.headers?.['authorization'];
  if (!authHeader) return 'viewer';
  
  const token = authHeader.replace('Bearer ', '');
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return validateRole(payload.role) ? payload.role : 'viewer';
  } catch {
    return 'viewer';
  }
}

function getUserId(event: APIGatewayEvent): string {
  const authHeader = event.headers?.['Authorization'] || event.headers?.['authorization'];
  if (!authHeader) return 'anonymous';
  
  const token = authHeader.replace('Bearer ', '');
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return payload.userId || 'anonymous';
  } catch {
    return 'anonymous';
  }
}

async function createAuditLog(userId: string, action: string, details: any) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${crypto.randomUUID()}`,
    userId,
    action,
    details: JSON.stringify(details),
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

function validateTableIndex(tableIndex: string): boolean {
  return tableIndex in TABLE_CONFIGS;
}

function addTimestamps(item: any, isUpdate: boolean = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

export async function handler(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  try {
    const userRole = getUserRole(event);
    const userId = getUserId(event);
    const method = event.httpMethod;
    const path = event.path;

    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(userRole, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      try {
        const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
          index,
          name: config.name,
          pk: config.pk
        }));
        
        return createResponse(200, { resources });
      } catch (error) {
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    const pathMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(\w+))?$/);
    if (!pathMatch) {
      return createResponse(404, { error: 'Not found' });
    }

    const [, tableIndex, action, subAction] = pathMatch;
    
    if (!validateTableIndex(tableIndex)) {
      return createResponse(400, { error: 'Invalid table index' });
    }

    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const pk = tableConfig.pk;

    if (action === 'bulk' && method === 'POST') {
      if (!hasPermission(userRole, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
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

        const chunks = chunkArray(items, 25);
        
        for (const chunk of chunks) {
          const writeRequests = chunk.map(item => {
            const processedItem = {
              ...item,
              pk,
              sk: item.id || crypto.randomUUID(),
              ...addTimestamps(item)
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

        await createAuditLog(userId, 'BULK_IMPORT', {
          table: tableConfig.name,
          imported,
          failed,
          total: items.length
        });

        return createResponse(200, { imported, failed, errors });
      } catch (error) {
        return createResponse(400, { error: 'Invalid request body' });
      }
    }

    switch (method) {
      case 'GET':
        if (!hasPermission(userRole, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (event.pathParameters?.id) {
          const id = event.pathParameters.id;
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk, sk: id }
          }));
          
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, result.Item);
        } else {
          const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 100;
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: { ':pk': pk },
            Limit: limit
          }));
          
          return createResponse(200, { items: result.Items || [], count: result.Count });
        }

      case 'POST':
        if (!hasPermission(userRole, 'write')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        try {
          const body = JSON.parse(event.body || '{}');
          const id = crypto.randomUUID();
          const item = {
            ...body,
            pk,
            sk: id,
            ...addTimestamps(body)
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: item
          }));

          await createAuditLog(userId, 'CREATE', { table: tableConfig.name, id, data: body });
          
          return createResponse(201, { id, ...item });
        } catch (error) {
          return createResponse(400, { error: 'Invalid request body' });
        }

      case 'PUT':
        if (!hasPermission(userRole, 'write')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (!event.pathParameters?.id) {
          return createResponse(400, { error: 'ID is required' });
        }

        try {
          const body = JSON.parse(event.body || '{}');
          const id = event.pathParameters.id;
          
          const existingItem = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk, sk: id }
          }));
          
          if (!existingItem.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          const updatedItem = {
            ...existingItem.Item,
            ...body,
            pk,
            sk: id,
            ...addTimestamps(body, true)
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          }));

          await createAuditLog(userId, 'UPDATE', { table: tableConfig.name, id, oldData: existingItem.Item, newData: body });
          
          return createResponse(200, updatedItem);
        } catch (error) {
          return createResponse(400, { error: 'Invalid request body' });
        }

      case 'DELETE':
        if (!hasPermission(userRole, 'delete')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (!event.pathParameters?.id) {
          return createResponse(400, { error: 'ID is required' });
        }

        const id = event.pathParameters.id;
        
        const existingItem = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk, sk: id }
        }));
        
        if (!existingItem.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { pk, sk: id }
        }));

        await createAuditLog(userId, 'DELETE', { table: tableConfig.name, id, deletedData: existingItem.Item });
        
        return createResponse(200, { message: 'Item deleted successfully' });

      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}