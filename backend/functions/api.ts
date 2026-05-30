import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
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
  const auditItem = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${crypto.randomUUID()}`,
    userId,
    action,
    details: JSON.stringify(details),
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditItem
  }));
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

      const resources = Object.entries(TABLE_CONFIGS).map(([key, config]) => ({
        id: key,
        name: config.name,
        pk: config.pk
      }));

      return createResponse(200, { resources });
    }

    const pathMatch = path.match(/^\/api\/([^/]+)(?:\/([^/]+))?$/);
    if (!pathMatch) {
      return createResponse(404, { error: 'Not found' });
    }

    const [, tableKey, itemId] = pathMatch;
    const tableConfig = TABLE_CONFIGS[tableKey as keyof typeof TABLE_CONFIGS];
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }

    const { pk } = tableConfig;

    if (method === 'GET' && !itemId) {
      if (!hasPermission(auth.role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const command = new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'pk = :pk',
        ExpressionAttributeValues: {
          ':pk': pk
        }
      });

      const result = await docClient.send(command);
      return createResponse(200, { items: result.Items || [] });
    }

    if (method === 'GET' && itemId) {
      if (!hasPermission(auth.role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const command = new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk, sk: itemId }
      });

      const result = await docClient.send(command);
      if (!result.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      return createResponse(200, result.Item);
    }

    if (method === 'POST' && path.endsWith('/bulk')) {
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
      const now = new Date().toISOString();

      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        const writeRequests = batch.map(item => ({
          PutRequest: {
            Item: {
              ...item,
              pk,
              sk: item.id || crypto.randomUUID(),
              createdAt: now,
              updatedAt: now,
              createdBy: auth.userId,
              updatedBy: auth.userId
            }
          }
        }));

        try {
          await docClient.send(new BatchWriteCommand({
            RequestItems: {
              [TABLE_NAME]: writeRequests
            }
          }));
          imported += batch.length;
        } catch (error) {
          failed += batch.length;
          errors.push(`Batch ${Math.floor(i/25) + 1}: ${error}`);
        }
      }

      await createAuditLog(auth.userId, 'BULK_IMPORT', {
        table: tableKey,
        imported,
        failed,
        total: items.length
      });

      return createResponse(200, { imported, failed, errors });
    }

    if (method === 'POST') {
      if (!hasPermission(auth.role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const body = JSON.parse(event.body || '{}');
      const now = new Date().toISOString();
      const id = body.id || crypto.randomUUID();

      const item = {
        ...body,
        pk,
        sk: id,
        createdAt: now,
        updatedAt: now,
        createdBy: auth.userId,
        updatedBy: auth.userId
      };

      const command = new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      });

      await docClient.send(command);
      await createAuditLog(auth.userId, 'CREATE', { table: tableKey, id });

      return createResponse(201, item);
    }

    if (method === 'PUT' && itemId) {
      if (!hasPermission(auth.role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const body = JSON.parse(event.body || '{}');
      const now = new Date().toISOString();

      const item = {
        ...body,
        pk,
        sk: itemId,
        updatedAt: now,
        updatedBy: auth.userId
      };

      const command = new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      });

      await docClient.send(command);
      await createAuditLog(auth.userId, 'UPDATE', { table: tableKey, id: itemId });

      return createResponse(200, item);
    }

    if (method === 'DELETE' && itemId) {
      if (!hasPermission(auth.role, 'delete')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const command = new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { pk, sk: itemId }
      });

      await docClient.send(command);
      await createAuditLog(auth.userId, 'DELETE', { table: tableKey, id: itemId });

      return createResponse(200, { message: 'Item deleted successfully' });
    }

    return createResponse(405, { error: 'Method not allowed' });

  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }
    
    if (error instanceof Error && error.message === 'Invalid role') {
      return createResponse(403, { error: 'Invalid role' });
    }
    
    return createResponse(500, { error: 'Internal server error' });
  }
};