import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { hasPermission, validateRole, Role } from './rbac';
import * as crypto from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface Resource {
  pk: string;
  sk: string;
  id: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
  [key: string]: any;
}

const TABLE_CONFIGS = {
  'login-users': { pk: 'LOGIN_USER', name: 'ログインユーザー' },
  'stores': { pk: 'STORE', name: '店舗' },
  'sales-data': { pk: 'SALES_DATA', name: '売上データ' },
  'operation-history': { pk: 'OPERATION_HISTORY', name: '操作履歴' },
  'location-data': { pk: 'LOCATION_DATA', name: '立地データ' },
  'trade-area-analysis': { pk: 'TRADE_AREA_ANALYSIS', name: '商圏分析結果' },
  'competitor-survey': { pk: 'COMPETITOR_SURVEY', name: '競合調査データ' },
  'candidate-locations': { pk: 'CANDIDATE_LOCATION', name: '候補地' },
  'demographic-data': { pk: 'DEMOGRAPHIC_DATA', name: '人口統計データ' },
  'consumer-attributes': { pk: 'CONSUMER_ATTRIBUTES', name: '消費者属性情報' },
  'market-size-results': { pk: 'MARKET_SIZE_RESULT', name: '市場規模算出結果' },
  'competitor-salons': { pk: 'COMPETITOR_SALON', name: '競合サロン' },
  'analysis-reports': { pk: 'ANALYSIS_REPORT', name: '分析レポート' },
  'data-collection-history': { pk: 'DATA_COLLECTION_HISTORY', name: 'データ収集履歴' }
};

function getTableConfig(path: string) {
  const match = path.match(/\/api\/([^/]+)/);
  if (!match) return null;
  
  const tableKey = match[1];
  return TABLE_CONFIGS[tableKey as keyof typeof TABLE_CONFIGS] || null;
}

function getUserFromEvent(event: APIGatewayProxyEvent): { userId: string; role: Role } {
  const userId = event.headers['x-user-id'] || 'system';
  const role = validateRole(event.headers['x-user-role'] || 'viewer');
  return { userId, role };
}

async function createAuditLog(userId: string, action: string, tableName: string, details: any) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${crypto.randomUUID()}`,
    id: crypto.randomUUID(),
    userId,
    action,
    tableName,
    details: JSON.stringify(details),
    timestamp: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
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

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const { userId, role } = getUserFromEvent(event);
    const method = event.httpMethod;
    const path = event.path;
    
    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    if (path === '/resources' && method === 'GET') {
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

    const tableConfig = getTableConfig(path);
    if (!tableConfig) {
      return createResponse(404, { error: 'Resource not found' });
    }

    const isBulkEndpoint = path.includes('/bulk');
    
    if (isBulkEndpoint && method === 'POST') {
      if (!hasPermission(role, 'write')) {
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

      // Process in batches of 25 (DynamoDB BatchWrite limit)
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        const writeRequests = batch.map(item => {
          const id = item.id || crypto.randomUUID();
          return {
            PutRequest: {
              Item: {
                ...item,
                pk: tableConfig.pk,
                sk: id,
                id,
                createdAt: now,
                updatedAt: now,
                createdBy: userId,
                updatedBy: userId
              }
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

      await createAuditLog(userId, 'BULK_IMPORT', tableConfig.name, {
        imported,
        failed,
        totalItems: items.length
      });

      return createResponse(200, { imported, failed, errors });
    }

    switch (method) {
      case 'GET': {
        if (!hasPermission(role, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const id = event.pathParameters?.id;
        if (id) {
          // Get single item
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: tableConfig.pk, sk: id }
          }));
          
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, { item: result.Item });
        } else {
          // List items
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: {
              ':pk': tableConfig.pk
            }
          }));
          
          return createResponse(200, { items: result.Items || [] });
        }
      }

      case 'POST': {
        if (!hasPermission(role, 'write')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const body = JSON.parse(event.body || '{}');
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        
        const item: Resource = {
          ...body,
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
          Item: item
        }));

        await createAuditLog(userId, 'CREATE', tableConfig.name, { id, data: body });
        
        return createResponse(201, { item });
      }

      case 'PUT': {
        if (!hasPermission(role, 'write')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const id = event.pathParameters?.id;
        if (!id) {
          return createResponse(400, { error: 'ID is required' });
        }

        // Check if item exists
        const existingResult = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk: tableConfig.pk, sk: id }
        }));
        
        if (!existingResult.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        const body = JSON.parse(event.body || '{}');
        const now = new Date().toISOString();
        
        const item: Resource = {
          ...existingResult.Item,
          ...body,
          pk: tableConfig.pk,
          sk: id,
          id,
          updatedAt: now,
          updatedBy: userId
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        }));

        await createAuditLog(userId, 'UPDATE', tableConfig.name, {
          id,
          oldData: existingResult.Item,
          newData: body
        });
        
        return createResponse(200, { item });
      }

      case 'DELETE': {
        if (!hasPermission(role, 'delete')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const id = event.pathParameters?.id;
        if (!id) {
          return createResponse(400, { error: 'ID is required' });
        }

        // Check if item exists
        const existingResult = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk: tableConfig.pk, sk: id }
        }));
        
        if (!existingResult.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { pk: tableConfig.pk, sk: id }
        }));

        await createAuditLog(userId, 'DELETE', tableConfig.name, {
          id,
          deletedData: existingResult.Item
        });
        
        return createResponse(200, { message: 'Item deleted successfully' });
      }

      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof Error && error.message === 'Invalid role') {
      return createResponse(400, { error: 'Invalid role specified' });
    }
    
    return createResponse(500, {
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};