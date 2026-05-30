import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, DeleteCommand, UpdateCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
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

function extractAuth(event: APIGatewayProxyEvent): AuthContext {
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

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const auth = extractAuth(event);
    const path = event.path;
    const method = event.httpMethod;

    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(auth.role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index,
        name: config.name,
        pk: config.pk
      }));

      return createResponse(200, { resources });
    }

    const pathMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(\w+))?$/);
    if (!pathMatch) {
      return createResponse(404, { error: 'Not found' });
    }

    const [, tableIndex, action, itemId] = pathMatch;
    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }

    if (action === 'bulk' && method === 'POST') {
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

      const chunks = [];
      for (let i = 0; i < items.length; i += 25) {
        chunks.push(items.slice(i, i + 25));
      }

      for (const chunk of chunks) {
        const writeRequests = chunk.map(item => {
          const now = new Date().toISOString();
          const enrichedItem = {
            ...item,
            pk: tableConfig.pk,
            sk: item.id || crypto.randomUUID(),
            id: item.id || crypto.randomUUID(),
            createdAt: now,
            updatedAt: now,
            createdBy: auth.userId,
            updatedBy: auth.userId
          };

          return {
            PutRequest: {
              Item: enrichedItem
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

      await createAuditLog(auth.userId, 'BULK_IMPORT', {
        tableIndex,
        tableName: tableConfig.name,
        imported,
        failed
      });

      return createResponse(200, { imported, failed, errors });
    }

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

    if (!action && method === 'POST') {
      if (!hasPermission(auth.role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const body = JSON.parse(event.body || '{}');
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      
      const item = {
        ...body,
        pk: tableConfig.pk,
        sk: id,
        id,
        createdAt: now,
        updatedAt: now,
        createdBy: auth.userId,
        updatedBy: auth.userId
      };

      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      }));

      await createAuditLog(auth.userId, 'CREATE', {
        tableIndex,
        tableName: tableConfig.name,
        itemId: id
      });

      return createResponse(201, item);
    }

    if (itemId && method === 'GET') {
      if (!hasPermission(auth.role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: itemId
        }
      }));

      if (!result.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      return createResponse(200, result.Item);
    }

    if (itemId && method === 'PUT') {
      if (!hasPermission(auth.role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const body = JSON.parse(event.body || '{}');
      const now = new Date().toISOString();
      
      const item = {
        ...body,
        pk: tableConfig.pk,
        sk: itemId,
        id: itemId,
        updatedAt: now,
        updatedBy: auth.userId
      };

      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      }));

      await createAuditLog(auth.userId, 'UPDATE', {
        tableIndex,
        tableName: tableConfig.name,
        itemId
      });

      return createResponse(200, item);
    }

    if (itemId && method === 'DELETE') {
      if (!hasPermission(auth.role, 'delete')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      await docClient.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: itemId
        }
      }));

      await createAuditLog(auth.userId, 'DELETE', {
        tableIndex,
        tableName: tableConfig.name,
        itemId
      });

      return createResponse(200, { message: 'Item deleted successfully' });
    }

    return createResponse(404, { error: 'Not found' });

  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};