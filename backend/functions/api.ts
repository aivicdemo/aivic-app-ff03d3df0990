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
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  headers: { [key: string]: string };
  body?: string;
}

interface APIGatewayResponse {
  statusCode: number;
  headers: { [key: string]: string };
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
  if (!authHeader) {
    throw new Error('Authorization header required');
  }
  
  try {
    const token = authHeader.replace('Bearer ', '');
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return validateRole(payload.role);
  } catch {
    throw new Error('Invalid token');
  }
}

function getUserId(event: APIGatewayEvent): string {
  const authHeader = event.headers.Authorization || event.headers.authorization;
  if (!authHeader) {
    return 'system';
  }
  
  try {
    const token = authHeader.replace('Bearer ', '');
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return payload.userId || 'system';
  } catch {
    return 'system';
  }
}

async function createAuditLog(userId: string, action: string, target: string, details: any) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${crypto.randomUUID()}`,
    userId,
    action,
    target,
    details: JSON.stringify(details),
    timestamp: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

function getTableConfig(path: string) {
  const segments = path.split('/');
  const resourceIndex = segments.findIndex(s => s === 'resources') + 1;
  const resource = segments[resourceIndex];
  
  if (!resource || !TABLE_CONFIGS[resource as keyof typeof TABLE_CONFIGS]) {
    throw new Error('Invalid resource');
  }
  
  return TABLE_CONFIGS[resource as keyof typeof TABLE_CONFIGS];
}

function validateAndEnrichItem(item: any, isUpdate = false): any {
  const now = new Date().toISOString();
  
  if (!isUpdate) {
    item.id = item.id || crypto.randomUUID();
    item.createdAt = now;
  }
  item.updatedAt = now;
  
  return item;
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const userRole = getUserRole(event);
    const userId = getUserId(event);
    
    if (event.path === '/resources') {
      if (event.httpMethod === 'GET') {
        if (!hasPermission(userRole, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }
        
        const resources = Object.entries(TABLE_CONFIGS).map(([key, config]) => ({
          id: key,
          name: config.name,
          type: config.pk
        }));
        
        return createResponse(200, { resources });
      }
    }

    const tableConfig = getTableConfig(event.path);
    const pathSegments = event.path.split('/');
    const isBulkEndpoint = pathSegments[pathSegments.length - 1] === 'bulk';
    const resourceId = pathSegments[pathSegments.length - 1];
    
    if (isBulkEndpoint && event.httpMethod === 'POST') {
      if (!hasPermission(userRole, 'write')) {
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
        try {
          const writeRequests = chunk.map(item => {
            const enrichedItem = validateAndEnrichItem({
              ...item,
              pk: tableConfig.pk,
              sk: item.id || crypto.randomUUID()
            });
            
            return {
              PutRequest: {
                Item: enrichedItem
              }
            };
          });
          
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
      
      await createAuditLog(userId, 'BULK_IMPORT', tableConfig.name, {
        imported,
        failed,
        totalItems: items.length
      });
      
      return createResponse(200, { imported, failed, errors });
    }
    
    switch (event.httpMethod) {
      case 'GET':
        if (!hasPermission(userRole, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }
        
        if (resourceId && resourceId !== 'bulk') {
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: tableConfig.pk, sk: resourceId }
          }));
          
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, result.Item);
        } else {
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: {
              ':pk': tableConfig.pk
            }
          }));
          
          return createResponse(200, { items: result.Items || [] });
        }
        
      case 'POST':
        if (!hasPermission(userRole, 'write')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }
        
        const createBody = JSON.parse(event.body || '{}');
        const newItem = validateAndEnrichItem({
          ...createBody,
          pk: tableConfig.pk,
          sk: createBody.id || crypto.randomUUID(),
          createdBy: userId,
          updatedBy: userId
        });
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: newItem
        }));
        
        await createAuditLog(userId, 'CREATE', tableConfig.name, { id: newItem.sk });
        
        return createResponse(201, newItem);
        
      case 'PUT':
        if (!hasPermission(userRole, 'write')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }
        
        if (!resourceId) {
          return createResponse(400, { error: 'Resource ID required' });
        }
        
        const updateBody = JSON.parse(event.body || '{}');
        const updatedItem = validateAndEnrichItem({
          ...updateBody,
          pk: tableConfig.pk,
          sk: resourceId,
          updatedBy: userId
        }, true);
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));
        
        await createAuditLog(userId, 'UPDATE', tableConfig.name, { id: resourceId });
        
        return createResponse(200, updatedItem);
        
      case 'DELETE':
        if (!hasPermission(userRole, 'delete')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }
        
        if (!resourceId) {
          return createResponse(400, { error: 'Resource ID required' });
        }
        
        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { pk: tableConfig.pk, sk: resourceId }
        }));
        
        await createAuditLog(userId, 'DELETE', tableConfig.name, { id: resourceId });
        
        return createResponse(200, { message: 'Item deleted successfully' });
        
      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
    
  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof Error) {
      if (error.message.includes('Authorization') || error.message.includes('Invalid token') || error.message.includes('Invalid role')) {
        return createResponse(401, { error: 'Unauthorized' });
      }
      if (error.message.includes('Invalid resource')) {
        return createResponse(404, { error: 'Resource not found' });
      }
    }
    
    return createResponse(500, { error: 'Internal server error' });
  }
};