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
  '0': { pk: 'LOGIN_USER', name: 'ログインユーザー' },
  '1': { pk: 'STORE', name: '店舗' },
  '2': { pk: 'SALES_DATA', name: '売上データ' },
  '3': { pk: 'OPERATION_HISTORY', name: '操作履歴' },
  '4': { pk: 'LOCATION_DATA', name: '立地データ' },
  '5': { pk: 'TRADE_AREA_ANALYSIS', name: '商圏分析結果' },
  '6': { pk: 'COMPETITOR_SURVEY', name: '競合調査データ' },
  '7': { pk: 'CANDIDATE_LOCATION', name: '候補地' },
  '8': { pk: 'POPULATION_STATISTICS', name: '人口統計データ' },
  '9': { pk: 'CONSUMER_ATTRIBUTES', name: '消費者属性情報' },
  '10': { pk: 'MARKET_SIZE_RESULT', name: '市場規模算出結果' },
  '11': { pk: 'COMPETITOR_SALON', name: '競合サロン' },
  '12': { pk: 'ANALYSIS_REPORT', name: '分析レポート' },
  '13': { pk: 'DATA_COLLECTION_HISTORY', name: 'データ収集履歴' }
};

function getAuthContext(event: APIGatewayProxyEvent): AuthContext {
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
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

function validateTableIndex(tableIndex: string): string {
  if (!TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS]) {
    throw new Error('Invalid table index');
  }
  return tableIndex;
}

function addTimestamps(item: any, isUpdate: boolean = false): any {
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

    const auth = getAuthContext(event);
    const path = event.path;
    const method = event.httpMethod;

    // GET /resources エンドポイント
    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(auth.role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index,
        pk: config.pk,
        name: config.name,
        endpoints: {
          list: `GET /api/${index}`,
          get: `GET /api/${index}/{id}`,
          create: `POST /api/${index}`,
          update: `PUT /api/${index}/{id}`,
          delete: `DELETE /api/${index}/{id}`,
          bulk: `POST /api/${index}/bulk`
        }
      }));

      return createResponse(200, { resources });
    }

    // API endpoints
    const apiMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(\w+))?$/);
    if (!apiMatch) {
      return createResponse(404, { error: 'Endpoint not found' });
    }

    const [, tableIndex, id, action] = apiMatch;
    
    try {
      validateTableIndex(tableIndex);
    } catch (error) {
      return createResponse(400, { error: 'Invalid table index' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];

    // Bulk import endpoint
    if (action === 'bulk' && method === 'POST') {
      if (!hasPermission(auth.role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      let requestBody;
      try {
        requestBody = JSON.parse(event.body || '{}');
      } catch (error) {
        return createResponse(400, { error: 'Invalid JSON in request body' });
      }

      if (!requestBody.items || !Array.isArray(requestBody.items)) {
        return createResponse(400, { error: 'Request body must contain items array' });
      }

      const items = requestBody.items;
      let imported = 0;
      let failed = 0;
      const errors: string[] = [];

      // Process in batches of 25 (DynamoDB BatchWrite limit)
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        const writeRequests = batch.map((item: any) => {
          const processedItem = {
            ...item,
            pk: config.pk,
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
              [TABLE_NAME]: writeRequests
            }
          }));
          imported += batch.length;
        } catch (error) {
          failed += batch.length;
          errors.push(`Batch ${Math.floor(i / 25) + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      await writeAuditLog(auth.userId, 'BULK_IMPORT', {
        tableIndex,
        tableName: config.name,
        imported,
        failed,
        totalItems: items.length
      });

      return createResponse(200, { imported, failed, errors });
    }

    // List items
    if (!id && method === 'GET') {
      if (!hasPermission(auth.role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const result = await docClient.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'pk = :pk',
        ExpressionAttributeValues: {
          ':pk': config.pk
        }
      }));

      return createResponse(200, { items: result.Items || [] });
    }

    // Get single item
    if (id && method === 'GET') {
      if (!hasPermission(auth.role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: config.pk,
          sk: id
        }
      }));

      if (!result.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      return createResponse(200, result.Item);
    }

    // Create item
    if (!id && method === 'POST') {
      if (!hasPermission(auth.role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      let requestBody;
      try {
        requestBody = JSON.parse(event.body || '{}');
      } catch (error) {
        return createResponse(400, { error: 'Invalid JSON in request body' });
      }

      const itemId = requestBody.id || crypto.randomUUID();
      const item = {
        ...requestBody,
        pk: config.pk,
        sk: itemId,
        id: itemId,
        ...addTimestamps(requestBody, false),
        createdBy: auth.userId,
        updatedBy: auth.userId
      };

      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      }));

      await writeAuditLog(auth.userId, 'CREATE', {
        tableIndex,
        tableName: config.name,
        itemId,
        item
      });

      return createResponse(201, item);
    }

    // Update item
    if (id && method === 'PUT') {
      if (!hasPermission(auth.role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      let requestBody;
      try {
        requestBody = JSON.parse(event.body || '{}');
      } catch (error) {
        return createResponse(400, { error: 'Invalid JSON in request body' });
      }

      // Check if item exists
      const existingItem = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: config.pk,
          sk: id
        }
      }));

      if (!existingItem.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      const updatedItem = {
        ...existingItem.Item,
        ...requestBody,
        pk: config.pk,
        sk: id,
        id,
        ...addTimestamps(requestBody, true),
        updatedBy: auth.userId
      };

      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: updatedItem
      }));

      await writeAuditLog(auth.userId, 'UPDATE', {
        tableIndex,
        tableName: config.name,
        itemId: id,
        oldItem: existingItem.Item,
        newItem: updatedItem
      });

      return createResponse(200, updatedItem);
    }

    // Delete item
    if (id && method === 'DELETE') {
      if (!hasPermission(auth.role, 'delete')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      // Check if item exists
      const existingItem = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: config.pk,
          sk: id
        }
      }));

      if (!existingItem.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      await docClient.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: config.pk,
          sk: id
        }
      }));

      await writeAuditLog(auth.userId, 'DELETE', {
        tableIndex,
        tableName: config.name,
        itemId: id,
        deletedItem: existingItem.Item
      });

      return createResponse(200, { message: 'Item deleted successfully' });
    }

    return createResponse(405, { error: 'Method not allowed' });

  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, {
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};