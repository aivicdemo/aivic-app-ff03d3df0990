import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { hasPermission, validateRole, Role } from './rbac';
import * as crypto from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE || 'main-table';

interface AuthContext {
  userId: string;
  role: Role;
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

function extractAuth(event: APIGatewayProxyEvent): AuthContext {
  const userId = event.headers['x-user-id'] || 'anonymous';
  const roleHeader = event.headers['x-user-role'] || 'viewer';
  
  if (!validateRole(roleHeader)) {
    throw new Error('Invalid role');
  }
  
  return { userId, role: roleHeader };
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

async function createAuditLog(auth: AuthContext, action: string, details: any): Promise<void> {
  const auditItem = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${crypto.randomUUID()}`,
    userId: auth.userId,
    action,
    details: JSON.stringify(details),
    timestamp: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditItem
  }));
}

function getTableConfig(path: string) {
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2 || segments[0] !== 'resources') {
    return null;
  }
  
  const tableKey = segments[1];
  return TABLE_CONFIGS[tableKey as keyof typeof TABLE_CONFIGS] || null;
}

function validateItem(item: any, tableConfig: any): string[] {
  const errors: string[] = [];
  
  if (!item) {
    errors.push('Item is required');
    return errors;
  }
  
  // Basic validation - can be extended per table
  if (typeof item !== 'object') {
    errors.push('Item must be an object');
  }
  
  return errors;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const auth = extractAuth(event);
    const path = event.path;
    const method = event.httpMethod;
    
    // Handle /resources endpoint
    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(auth.role, 'read')) {
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
    
    const pathSegments = path.split('/').filter(Boolean);
    const isBulkEndpoint = pathSegments[2] === 'bulk';
    const itemId = pathSegments[2] && pathSegments[2] !== 'bulk' ? pathSegments[2] : null;
    
    // Handle bulk import
    if (isBulkEndpoint && method === 'POST') {
      if (!hasPermission(auth.role, 'write')) {
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
      
      // Process in batches of 25 (DynamoDB BatchWrite limit)
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        const writeRequests = [];
        
        for (const item of batch) {
          const validationErrors = validateItem(item, tableConfig);
          if (validationErrors.length > 0) {
            failed++;
            errors.push(...validationErrors);
            continue;
          }
          
          const now = new Date().toISOString();
          const processedItem = {
            ...item,
            pk: tableConfig.pk,
            sk: item.id || crypto.randomUUID(),
            id: item.id || crypto.randomUUID(),
            createdAt: now,
            updatedAt: now,
            createdBy: auth.userId,
            updatedBy: auth.userId
          };
          
          writeRequests.push({
            PutRequest: {
              Item: processedItem
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
      
      await createAuditLog(auth, 'BULK_IMPORT', {
        table: tableConfig.name,
        imported,
        failed,
        totalItems: items.length
      });
      
      return createResponse(200, { imported, failed, errors });
    }
    
    // Handle CRUD operations
    switch (method) {
      case 'GET':
        if (!hasPermission(auth.role, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }
        
        if (itemId) {
          // Get single item
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: tableConfig.pk, sk: itemId }
          }));
          
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, result.Item);
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
      
      case 'POST':
        if (!hasPermission(auth.role, 'write')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }
        
        const createBody = JSON.parse(event.body || '{}');
        const createErrors = validateItem(createBody, tableConfig);
        
        if (createErrors.length > 0) {
          return createResponse(400, { errors: createErrors });
        }
        
        const newId = crypto.randomUUID();
        const now = new Date().toISOString();
        const newItem = {
          ...createBody,
          pk: tableConfig.pk,
          sk: newId,
          id: newId,
          createdAt: now,
          updatedAt: now,
          createdBy: auth.userId,
          updatedBy: auth.userId
        };
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: newItem
        }));
        
        await createAuditLog(auth, 'CREATE', {
          table: tableConfig.name,
          itemId: newId,
          data: createBody
        });
        
        return createResponse(201, newItem);
      
      case 'PUT':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID is required for update' });
        }
        
        if (!hasPermission(auth.role, 'write')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }
        
        const updateBody = JSON.parse(event.body || '{}');
        const updateErrors = validateItem(updateBody, tableConfig);
        
        if (updateErrors.length > 0) {
          return createResponse(400, { errors: updateErrors });
        }
        
        // Check if item exists
        const existingItem = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk: tableConfig.pk, sk: itemId }
        }));
        
        if (!existingItem.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        const updatedItem = {
          ...existingItem.Item,
          ...updateBody,
          pk: tableConfig.pk,
          sk: itemId,
          id: itemId,
          updatedAt: new Date().toISOString(),
          updatedBy: auth.userId
        };
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));
        
        await createAuditLog(auth, 'UPDATE', {
          table: tableConfig.name,
          itemId,
          oldData: existingItem.Item,
          newData: updateBody
        });
        
        return createResponse(200, updatedItem);
      
      case 'DELETE':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID is required for deletion' });
        }
        
        if (!hasPermission(auth.role, 'delete')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }
        
        // Check if item exists before deletion
        const itemToDelete = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk: tableConfig.pk, sk: itemId }
        }));
        
        if (!itemToDelete.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { pk: tableConfig.pk, sk: itemId }
        }));
        
        await createAuditLog(auth, 'DELETE', {
          table: tableConfig.name,
          itemId,
          deletedData: itemToDelete.Item
        });
        
        return createResponse(200, { message: 'Item deleted successfully' });
      
      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
    
  } catch (error) {
    console.error('Handler error:', error);
    
    if (error instanceof Error) {
      if (error.message === 'Invalid role') {
        return createResponse(403, { error: 'Invalid role' });
      }
      
      if (error.message.includes('ValidationException')) {
        return createResponse(400, { error: 'Validation error', details: error.message });
      }
    }
    
    return createResponse(500, { error: 'Internal server error' });
  }
};