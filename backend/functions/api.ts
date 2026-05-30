import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserRole, extractUserId, Role } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface APIGatewayEvent {
  httpMethod: string;
  pathParameters: { [key: string]: string } | null;
  queryStringParameters: { [key: string]: string } | null;
  body: string | null;
  headers: { [key: string]: string };
}

interface APIGatewayResponse {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;
}

const RESOURCE_MAP: { [key: string]: string } = {
  '0': 'users',
  '1': 'stores', 
  '2': 'sales',
  '3': 'audit',
  '4': 'locations',
  '5': 'market-analysis',
  '6': 'competitor-research',
  '7': 'candidate-locations',
  '8': 'demographics',
  '9': 'consumer-attributes',
  '10': 'market-size',
  '11': 'competitor-salons',
  '12': 'analysis-reports',
  '13': 'data-collection'
};

const PK_MAP: { [key: string]: string } = {
  'users': 'USER',
  'stores': 'STORE',
  'sales': 'SALES',
  'audit': 'AUDIT',
  'locations': 'LOCATION',
  'market-analysis': 'MARKET_ANALYSIS',
  'competitor-research': 'COMPETITOR_RESEARCH',
  'candidate-locations': 'CANDIDATE_LOCATION',
  'demographics': 'DEMOGRAPHICS',
  'consumer-attributes': 'CONSUMER_ATTR',
  'market-size': 'MARKET_SIZE',
  'competitor-salons': 'COMPETITOR_SALON',
  'analysis-reports': 'ANALYSIS_REPORT',
  'data-collection': 'DATA_COLLECTION'
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

function validateRequired(data: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (!data[field]) {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

async function createAuditLog(userId: string, action: string, resource: string, details: any) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId,
    action,
    resource,
    details: JSON.stringify(details),
    timestamp: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

async function handleBulkImport(event: APIGatewayEvent, tableIndex: string): Promise<APIGatewayResponse> {
  const role = extractUserRole(event);
  const userId = extractUserId(event);
  
  if (!role || !userId) {
    return createResponse(401, { error: 'Unauthorized' });
  }
  
  if (!hasPermission(role, 'bulk', 'create')) {
    return createResponse(403, { error: 'Forbidden' });
  }
  
  const resource = RESOURCE_MAP[tableIndex];
  if (!resource) {
    return createResponse(404, { error: 'Resource not found' });
  }
  
  const pk = PK_MAP[resource];
  
  try {
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
      const writeRequests = batch.map(item => {
        const id = item.id || randomUUID();
        const now = new Date().toISOString();
        
        return {
          PutRequest: {
            Item: {
              ...item,
              pk,
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
        errors.push(`Batch ${Math.floor(i/25) + 1}: ${error}`);
      }
    }
    
    await createAuditLog(userId, 'BULK_IMPORT', resource, { imported, failed, total: items.length });
    
    return createResponse(200, { imported, failed, errors });
  } catch (error) {
    return createResponse(500, { error: 'Internal server error', details: String(error) });
  }
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }
  
  const path = event.pathParameters?.proxy || '';
  const pathParts = path.split('/');
  
  // Handle bulk import endpoints
  if (pathParts.length === 2 && pathParts[1] === 'bulk' && event.httpMethod === 'POST') {
    return handleBulkImport(event, pathParts[0]);
  }
  
  // Handle /resources endpoint
  if (path === 'resources' && event.httpMethod === 'GET') {
    const role = extractUserRole(event);
    const userId = extractUserId(event);
    
    if (!role || !userId) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    
    const resources = {
      users: { name: 'ログインユーザー', permissions: [] as string[] },
      stores: { name: '店舗', permissions: [] as string[] },
      sales: { name: '売上データ', permissions: [] as string[] },
      audit: { name: '操作履歴', permissions: [] as string[] },
      locations: { name: '立地データ', permissions: [] as string[] },
      'market-analysis': { name: '商圏分析結果', permissions: [] as string[] },
      'competitor-research': { name: '競合調査データ', permissions: [] as string[] },
      'candidate-locations': { name: '候補地', permissions: [] as string[] },
      demographics: { name: '人口統計データ', permissions: [] as string[] },
      'consumer-attributes': { name: '消費者属性情報', permissions: [] as string[] },
      'market-size': { name: '市場規模算出結果', permissions: [] as string[] },
      'competitor-salons': { name: '競合サロン', permissions: [] as string[] },
      'analysis-reports': { name: '分析レポート', permissions: [] as string[] },
      'data-collection': { name: 'データ収集履歴', permissions: [] as string[] }
    };
    
    // Add permissions based on role
    Object.keys(resources).forEach(resource => {
      if (hasPermission(role, resource, 'read')) {
        resources[resource as keyof typeof resources].permissions.push('read');
      }
      if (hasPermission(role, resource, 'create')) {
        resources[resource as keyof typeof resources].permissions.push('create');
      }
      if (hasPermission(role, resource, 'update')) {
        resources[resource as keyof typeof resources].permissions.push('update');
      }
      if (hasPermission(role, resource, 'delete')) {
        resources[resource as keyof typeof resources].permissions.push('delete');
      }
    });
    
    return createResponse(200, { resources, userRole: role });
  }
  
  // Handle table-specific endpoints
  const tableIndex = pathParts[0];
  const resource = RESOURCE_MAP[tableIndex];
  
  if (!resource) {
    return createResponse(404, { error: 'Resource not found' });
  }
  
  const role = extractUserRole(event);
  const userId = extractUserId(event);
  
  if (!role || !userId) {
    return createResponse(401, { error: 'Unauthorized' });
  }
  
  const pk = PK_MAP[resource];
  
  try {
    switch (event.httpMethod) {
      case 'GET':
        if (!hasPermission(role, resource, 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        if (pathParts.length === 2) {
          // Get specific item
          const id = pathParts[1];
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk, sk: id }
          }));
          
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, result.Item);
        } else {
          // List items
          const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 50;
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: { ':pk': pk },
            Limit: limit
          }));
          
          return createResponse(200, { items: result.Items || [], count: result.Count || 0 });
        }
        
      case 'POST':
        if (!hasPermission(role, resource, 'create')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        const createData = JSON.parse(event.body || '{}');
        const id = randomUUID();
        const now = new Date().toISOString();
        
        // Basic validation based on resource type
        let requiredFields: string[] = [];
        switch (resource) {
          case 'users':
            requiredFields = ['loginId', 'passwordHash', 'userName', 'email', 'permissionLevel'];
            break;
          case 'stores':
            requiredFields = ['storeCode', 'storeName', 'storeType', 'businessStatus'];
            break;
          case 'sales':
            requiredFields = ['storeId', 'posRegisterId', 'saleDate', 'saleAmount', 'taxExcludedAmount', 'taxAmount', 'transactionNumber', 'paymentMethod', 'customerCount', 'itemCount', 'saleType', 'businessDate'];
            break;
        }
        
        const validationErrors = validateRequired(createData, requiredFields);
        if (validationErrors.length > 0) {
          return createResponse(400, { error: 'Validation failed', details: validationErrors });
        }
        
        const newItem = {
          ...createData,
          pk,
          sk: id,
          id,
          createdAt: now,
          updatedAt: now,
          createdBy: userId,
          updatedBy: userId
        };
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: newItem
        }));
        
        await createAuditLog(userId, 'CREATE', resource, { id, data: createData });
        
        return createResponse(201, newItem);
        
      case 'PUT':
        if (!hasPermission(role, resource, 'update')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        if (pathParts.length !== 2) {
          return createResponse(400, { error: 'ID required for update' });
        }
        
        const updateId = pathParts[1];
        const updateData = JSON.parse(event.body || '{}');
        
        // Check if item exists
        const existingItem = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk, sk: updateId }
        }));
        
        if (!existingItem.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        const updatedItem = {
          ...existingItem.Item,
          ...updateData,
          updatedAt: new Date().toISOString(),
          updatedBy: userId
        };
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));
        
        await createAuditLog(userId, 'UPDATE', resource, { id: updateId, before: existingItem.Item, after: updatedItem });
        
        return createResponse(200, updatedItem);
        
      case 'DELETE':
        if (!hasPermission(role, resource, 'delete')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        if (pathParts.length !== 2) {
          return createResponse(400, { error: 'ID required for delete' });
        }
        
        const deleteId = pathParts[1];
        
        // Check if item exists
        const itemToDelete = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk, sk: deleteId }
        }));
        
        if (!itemToDelete.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { pk, sk: deleteId }
        }));
        
        await createAuditLog(userId, 'DELETE', resource, { id: deleteId, data: itemToDelete.Item });
        
        return createResponse(200, { message: 'Item deleted successfully' });
        
      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error', details: String(error) });
  }
};