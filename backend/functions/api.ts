import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
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
  headers: { [key: string]: string };
}

interface APIGatewayResponse {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;
}

const TABLE_CONFIGS = {
  '0': { name: 'LoginUser', pk: 'USER' },
  '1': { name: 'Store', pk: 'STORE' },
  '2': { name: 'SalesData', pk: 'SALES' },
  '3': { name: 'OperationHistory', pk: 'OPERATION' },
  '4': { name: 'LocationData', pk: 'LOCATION' },
  '5': { name: 'MarketAnalysisResult', pk: 'MARKET_ANALYSIS' },
  '6': { name: 'CompetitorSurveyData', pk: 'COMPETITOR_SURVEY' },
  '7': { name: 'CandidateLocation', pk: 'CANDIDATE' },
  '8': { name: 'PopulationStatistics', pk: 'POPULATION' },
  '9': { name: 'ConsumerAttribute', pk: 'CONSUMER' },
  '10': { name: 'MarketSizeResult', pk: 'MARKET_SIZE' },
  '11': { name: 'CompetitorSalon', pk: 'COMPETITOR_SALON' },
  '12': { name: 'AnalysisReport', pk: 'REPORT' },
  '13': { name: 'DataCollectionHistory', pk: 'DATA_COLLECTION' }
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

async function createAuditLog(user: User, action: string, resource: string, details: any) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.id,
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

function validateTableIndex(tableIndex: string): boolean {
  return tableIndex in TABLE_CONFIGS;
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

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    let user: User;
    try {
      user = extractUserFromEvent(event);
    } catch (error) {
      return createResponse(401, { error: 'Unauthorized' });
    }

    const path = event.path;
    const method = event.httpMethod;
    
    // Handle /resources endpoint
    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(user, 'resources', 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }
      
      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index,
        name: config.name,
        pk: config.pk
      }));
      
      return createResponse(200, { resources });
    }

    // Parse table-specific endpoints
    const pathMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(\w+))?$/);
    if (!pathMatch) {
      return createResponse(404, { error: 'Not found' });
    }

    const [, tableIndex, action, id] = pathMatch;
    
    if (!validateTableIndex(tableIndex)) {
      return createResponse(400, { error: 'Invalid table index' });
    }

    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const resource = tableConfig.name;

    // Handle bulk import endpoint
    if (action === 'bulk' && method === 'POST') {
      if (!hasPermission(user, resource, 'bulk')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const body = JSON.parse(event.body || '{}');
      const items = body.items || [];
      
      if (!Array.isArray(items)) {
        return createResponse(400, { error: 'Items must be an array' });
      }

      let imported = 0;
      let failed = 0;
      const errors: string[] = [];

      // Process items in batches of 25 (DynamoDB limit)
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        const putRequests = batch.map(item => {
          const processedItem = addTimestamps({
            ...item,
            pk: tableConfig.pk,
            sk: item.id || randomUUID(),
            id: item.id || randomUUID()
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

      await createAuditLog(user, 'BULK_IMPORT', resource, {
        imported,
        failed,
        totalItems: items.length
      });

      return createResponse(200, { imported, failed, errors });
    }

    // Handle CRUD operations
    switch (method) {
      case 'GET':
        if (!hasPermission(user, resource, 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        if (id) {
          // Get single item
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: tableConfig.pk, sk: id }
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
        if (!hasPermission(user, resource, 'create')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const createBody = JSON.parse(event.body || '{}');
        const newItem = addTimestamps({
          ...createBody,
          pk: tableConfig.pk,
          sk: createBody.id || randomUUID(),
          id: createBody.id || randomUUID(),
          createdBy: user.id,
          updatedBy: user.id
        });

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: newItem
        }));

        await createAuditLog(user, 'CREATE', resource, { id: newItem.id });
        
        return createResponse(201, newItem);

      case 'PUT':
        if (!id) {
          return createResponse(400, { error: 'ID required for update' });
        }
        
        if (!hasPermission(user, resource, 'update')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const updateBody = JSON.parse(event.body || '{}');
        const updatedItem = addTimestamps({
          ...updateBody,
          pk: tableConfig.pk,
          sk: id,
          id: id,
          updatedBy: user.id
        }, true);

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));

        await createAuditLog(user, 'UPDATE', resource, { id });
        
        return createResponse(200, updatedItem);

      case 'DELETE':
        if (!id) {
          return createResponse(400, { error: 'ID required for delete' });
        }
        
        if (!hasPermission(user, resource, 'delete')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { pk: tableConfig.pk, sk: id }
        }));

        await createAuditLog(user, 'DELETE', resource, { id });
        
        return createResponse(200, { message: 'Item deleted successfully' });

      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};