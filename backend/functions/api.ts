import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { getUserFromEvent, requirePermission } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface APIGatewayEvent {
  httpMethod: string;
  path: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  body?: string;
  headers?: { [key: string]: string };
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
  'competitor-survey': { pk: 'COMPETITOR_SURVEY', name: '競合調査データ' },
  'candidate-locations': { pk: 'CANDIDATE_LOCATION', name: '候補地' },
  'demographic-data': { pk: 'DEMOGRAPHIC_DATA', name: '人口統計データ' },
  'consumer-attributes': { pk: 'CONSUMER_ATTRIBUTES', name: '消費者属性情報' },
  'market-size-results': { pk: 'MARKET_SIZE_RESULT', name: '市場規模算出結果' },
  'competitor-salons': { pk: 'COMPETITOR_SALON', name: '競合サロン' },
  'analysis-reports': { pk: 'ANALYSIS_REPORT', name: '分析レポート' },
  'data-collection-history': { pk: 'DATA_COLLECTION_HISTORY', name: 'データ収集履歴' }
};

async function createAuditLog(user: any, action: string, details: any): Promise<void> {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.id,
    action,
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

function addTimestamps(item: any, isUpdate = false): any {
  const now = new Date().toISOString();
  const result = { ...item };
  
  if (!isUpdate) {
    result.createdAt = now;
  }
  result.updatedAt = now;
  
  return result;
}

function generateId(): string {
  return randomUUID();
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const user = getUserFromEvent(event);
    const path = event.path;
    const method = event.httpMethod;

    // Handle /resources endpoint
    if (path === '/resources' && method === 'GET') {
      requirePermission(user, 'read:all');
      
      const resources = Object.entries(TABLE_CONFIGS).map(([key, config]) => ({
        key,
        name: config.name,
        pk: config.pk
      }));
      
      return createResponse(200, { resources });
    }

    // Parse table-based routes
    const pathMatch = path.match(/^\/api\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
    if (!pathMatch) {
      return createResponse(404, { error: 'Route not found' });
    }

    const [, tableKey, action, id] = pathMatch;
    
    if (!validateTableKey(tableKey)) {
      return createResponse(400, { error: 'Invalid table key' });
    }

    const tableConfig = TABLE_CONFIGS[tableKey as keyof typeof TABLE_CONFIGS];
    const pk = tableConfig.pk;

    // Handle bulk import
    if (action === 'bulk' && method === 'POST') {
      requirePermission(user, 'bulk:import');
      
      const body = JSON.parse(event.body || '{}');
      const items = body.items || [];
      
      if (!Array.isArray(items)) {
        return createResponse(400, { error: 'Items must be an array' });
      }

      let imported = 0;
      let failed = 0;
      const errors: string[] = [];

      // Process in batches of 25 (DynamoDB BatchWrite limit)
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        const putRequests = batch.map(item => {
          const processedItem = addTimestamps({
            ...item,
            pk,
            sk: item.id || generateId()
          });
          
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
          errors.push(`Batch ${Math.floor(i/25) + 1}: ${error}`);
        }
      }

      await createAuditLog(user, 'BULK_IMPORT', {
        tableKey,
        imported,
        failed,
        totalItems: items.length
      });

      return createResponse(200, { imported, failed, errors });
    }

    // Handle CRUD operations
    switch (method) {
      case 'GET':
        requirePermission(user, 'read:all');
        
        if (id) {
          // Get single item
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk, sk: id }
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
              ':pk': pk
            }
          }));
          
          return createResponse(200, { items: result.Items || [] });
        }

      case 'POST':
        requirePermission(user, 'write:all');
        
        const createBody = JSON.parse(event.body || '{}');
        const newItem = addTimestamps({
          ...createBody,
          pk,
          sk: createBody.id || generateId()
        });
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: newItem
        }));
        
        await createAuditLog(user, 'CREATE', {
          tableKey,
          itemId: newItem.sk,
          item: newItem
        });
        
        return createResponse(201, { item: newItem });

      case 'PUT':
        requirePermission(user, 'write:all');
        
        if (!id) {
          return createResponse(400, { error: 'ID is required for update' });
        }
        
        const updateBody = JSON.parse(event.body || '{}');
        const updatedItem = addTimestamps({
          ...updateBody,
          pk,
          sk: id
        }, true);
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));
        
        await createAuditLog(user, 'UPDATE', {
          tableKey,
          itemId: id,
          item: updatedItem
        });
        
        return createResponse(200, { item: updatedItem });

      case 'DELETE':
        requirePermission(user, 'delete:all');
        
        if (!id) {
          return createResponse(400, { error: 'ID is required for delete' });
        }
        
        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { pk, sk: id }
        }));
        
        await createAuditLog(user, 'DELETE', {
          tableKey,
          itemId: id
        });
        
        return createResponse(200, { message: 'Item deleted successfully' });

      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
    
  } catch (error: any) {
    console.error('Error:', error);
    
    if (error.message.includes('Insufficient permissions')) {
      return createResponse(403, { error: 'Forbidden' });
    }
    
    if (error.message.includes('No authorization header')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    
    return createResponse(500, { error: 'Internal server error' });
  }
};