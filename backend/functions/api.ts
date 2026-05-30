import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserRole, Role } from './rbac';
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
  requestContext: {
    requestId: string;
    identity: {
      sourceIp: string;
      userAgent?: string;
    };
  };
}

interface APIResponse {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;
}

const TABLES = {
  '0': 'LOGIN_USER',
  '1': 'STORE',
  '2': 'SALES_DATA',
  '3': 'OPERATION_HISTORY',
  '4': 'LOCATION_DATA',
  '5': 'TRADE_AREA_ANALYSIS',
  '6': 'COMPETITOR_RESEARCH',
  '7': 'CANDIDATE_LOCATION',
  '8': 'POPULATION_STATISTICS',
  '9': 'CONSUMER_ATTRIBUTES',
  '10': 'MARKET_SIZE_CALCULATION',
  '11': 'COMPETITOR_SALON',
  '12': 'ANALYSIS_REPORT',
  '13': 'DATA_COLLECTION_HISTORY'
};

function createResponse(statusCode: number, body: any): APIResponse {
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

async function logAudit(operation: string, details: any, userId?: string, ip?: string) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    operation,
    details,
    userId: userId || 'system',
    ip: ip || 'unknown',
    timestamp: new Date().toISOString()
  };
  
  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: auditLog
    }));
  } catch (error) {
    console.error('Failed to log audit:', error);
  }
}

function validateRequired(item: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (!item[field] && item[field] !== 0 && item[field] !== false) {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function getTableRequiredFields(tableType: string): string[] {
  const fieldMap: { [key: string]: string[] } = {
    'LOGIN_USER': ['userId', 'loginId', 'passwordHash', 'userName', 'email', 'permissionLevel', 'activeFlag', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'],
    'STORE': ['storeId', 'storeCode', 'storeName', 'storeType', 'businessStatus', 'validFlag', 'createdAt', 'updatedAt', 'createdById', 'updatedById'],
    'SALES_DATA': ['salesId', 'storeId', 'posRegisterId', 'salesDate', 'salesAmount', 'taxExcludedAmount', 'taxAmount', 'transactionNumber', 'paymentMethod', 'customerCount', 'itemCount', 'salesType', 'businessDate', 'dataLinkageStatus', 'createdAt', 'updatedAt', 'createdBy'],
    'OPERATION_HISTORY': ['operationHistoryId', 'userId', 'userName', 'operationType', 'operationContent', 'ipAddress', 'operationResult', 'operationDateTime'],
    'LOCATION_DATA': ['locationId', 'locationName', 'prefecture', 'municipality', 'address', 'locationType', 'status', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'],
    'TRADE_AREA_ANALYSIS': ['tradeAreaAnalysisId', 'storeId', 'analysisName', 'analysisType', 'tradeAreaRadius', 'analysisStatus', 'analysisExecutionDateTime', 'createdById', 'createdAt', 'updatedAt'],
    'COMPETITOR_RESEARCH': ['competitorResearchId', 'targetStoreName', 'competitorCompanyName', 'storeAddress', 'businessType', 'surveyDate', 'surveyMethod', 'surveyor', 'status', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'],
    'CANDIDATE_LOCATION': ['candidateLocationId', 'candidateLocationName', 'prefecture', 'municipality', 'address', 'propertyType', 'considerationStatus', 'priority', 'personInChargeId', 'createdAt', 'updatedAt', 'createdById', 'updatedById'],
    'POPULATION_STATISTICS': ['populationStatisticsId', 'regionCode', 'regionName', 'statisticsYear', 'totalPopulation', 'householdCount', 'dataSource', 'validFlag', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'],
    'CONSUMER_ATTRIBUTES': ['consumerAttributeId', 'tradeAreaId', 'ageGroup', 'gender', 'householdIncomeGroup', 'occupationClassification', 'householdComposition', 'population', 'compositionRatio', 'dataAcquisitionYearMonth', 'dataSource', 'createdAt', 'updatedAt', 'createdById'],
    'MARKET_SIZE_CALCULATION': ['marketSizeCalculationId', 'calculationName', 'targetArea', 'calculationMethod', 'totalMarketSize', 'targetPopulation', 'referenceYearMonth', 'status', 'createdById', 'createdAt', 'updatedAt'],
    'COMPETITOR_SALON': ['competitorSalonId', 'salonName', 'address', 'businessStatus', 'serviceType', 'competitorLevel', 'surveyStatus', 'createdAt', 'updatedAt', 'createdById', 'updatedById'],
    'ANALYSIS_REPORT': ['reportId', 'reportName', 'reportType', 'analysisStartDate', 'analysisEndDate', 'reportContent', 'conclusionSummary', 'status', 'priority', 'publicFlag', 'createdById', 'createdAt', 'updatedAt'],
    'DATA_COLLECTION_HISTORY': ['collectionHistoryId', 'dataSourceType', 'dataSourceName', 'collectionStartDateTime', 'collectionStatus', 'collectionMethod', 'createdAt', 'updatedAt', 'createdById']
  };
  return fieldMap[tableType] || [];
}

function addTimestamps(item: any, isUpdate: boolean = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

function generatePrimaryKey(tableType: string): { pk: string; sk: string } {
  const id = randomUUID();
  return {
    pk: tableType,
    sk: id
  };
}

async function handleGetResources(event: APIGatewayEvent): Promise<APIResponse> {
  const role = extractUserRole(event);
  
  if (!hasPermission(role, 'resources', 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const tableIndex = event.pathParameters?.tableIndex;
    const id = event.pathParameters?.id;
    const tableType = tableIndex ? TABLES[tableIndex as keyof typeof TABLES] : null;

    if (tableIndex && !tableType) {
      return createResponse(400, { error: 'Invalid table index' });
    }

    if (id && tableType) {
      // Get specific item
      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: tableType, sk: id }
      }));

      if (!result.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      return createResponse(200, result.Item);
    } else if (tableType) {
      // Get all items for specific table
      const result = await docClient.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'pk = :pk',
        ExpressionAttributeValues: {
          ':pk': tableType
        }
      }));

      return createResponse(200, { items: result.Items || [] });
    } else {
      // Get all resources
      const result = await docClient.send(new ScanCommand({
        TableName: TABLE_NAME
      }));

      return createResponse(200, { items: result.Items || [] });
    }
  } catch (error) {
    console.error('Error getting resources:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreateResource(event: APIGatewayEvent): Promise<APIResponse> {
  const role = extractUserRole(event);
  
  if (!hasPermission(role, 'resources', 'create')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const tableIndex = event.pathParameters?.tableIndex;
    const tableType = tableIndex ? TABLES[tableIndex as keyof typeof TABLES] : null;

    if (!tableType) {
      return createResponse(400, { error: 'Invalid or missing table index' });
    }

    if (!event.body) {
      return createResponse(400, { error: 'Request body is required' });
    }

    const item = JSON.parse(event.body);
    const requiredFields = getTableRequiredFields(tableType);
    const validationErrors = validateRequired(item, requiredFields.filter(f => !['createdAt', 'updatedAt'].includes(f)));

    if (validationErrors.length > 0) {
      return createResponse(400, { error: 'Validation failed', details: validationErrors });
    }

    const { pk, sk } = generatePrimaryKey(tableType);
    const newItem = {
      ...item,
      pk,
      sk,
      id: sk
    };
    addTimestamps(newItem);

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: newItem
    }));

    await logAudit('CREATE', { tableType, itemId: sk }, 'user', event.requestContext.identity.sourceIp);

    return createResponse(201, newItem);
  } catch (error) {
    console.error('Error creating resource:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdateResource(event: APIGatewayEvent): Promise<APIResponse> {
  const role = extractUserRole(event);
  
  if (!hasPermission(role, 'resources', 'update')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const tableIndex = event.pathParameters?.tableIndex;
    const id = event.pathParameters?.id;
    const tableType = tableIndex ? TABLES[tableIndex as keyof typeof TABLES] : null;

    if (!tableType || !id) {
      return createResponse(400, { error: 'Invalid table index or missing ID' });
    }

    if (!event.body) {
      return createResponse(400, { error: 'Request body is required' });
    }

    const updates = JSON.parse(event.body);
    addTimestamps(updates, true);

    // Check if item exists
    const existing = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: tableType, sk: id }
    }));

    if (!existing.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    const updatedItem = { ...existing.Item, ...updates };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedItem
    }));

    await logAudit('UPDATE', { tableType, itemId: id, changes: updates }, 'user', event.requestContext.identity.sourceIp);

    return createResponse(200, updatedItem);
  } catch (error) {
    console.error('Error updating resource:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDeleteResource(event: APIGatewayEvent): Promise<APIResponse> {
  const role = extractUserRole(event);
  
  if (!hasPermission(role, 'resources', 'delete')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const tableIndex = event.pathParameters?.tableIndex;
    const id = event.pathParameters?.id;
    const tableType = tableIndex ? TABLES[tableIndex as keyof typeof TABLES] : null;

    if (!tableType || !id) {
      return createResponse(400, { error: 'Invalid table index or missing ID' });
    }

    // Check if item exists
    const existing = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: tableType, sk: id }
    }));

    if (!existing.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { pk: tableType, sk: id }
    }));

    await logAudit('DELETE', { tableType, itemId: id }, 'user', event.requestContext.identity.sourceIp);

    return createResponse(200, { message: 'Item deleted successfully' });
  } catch (error) {
    console.error('Error deleting resource:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleBulkImport(event: APIGatewayEvent): Promise<APIResponse> {
  const role = extractUserRole(event);
  
  if (!hasPermission(role, 'resources', 'bulk')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const tableIndex = event.pathParameters?.tableIndex;
    const tableType = tableIndex ? TABLES[tableIndex as keyof typeof TABLES] : null;

    if (!tableType) {
      return createResponse(400, { error: 'Invalid or missing table index' });
    }

    if (!event.body) {
      return createResponse(400, { error: 'Request body is required' });
    }

    const { items } = JSON.parse(event.body);
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
        try {
          const { pk, sk } = generatePrimaryKey(tableType);
          const newItem = {
            ...item,
            pk,
            sk,
            id: sk
          };
          addTimestamps(newItem);

          writeRequests.push({
            PutRequest: {
              Item: newItem
            }
          });
        } catch (error) {
          failed++;
          errors.push(`Item ${i + writeRequests.length}: ${error}`);
        }
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
          errors.push(`Batch ${Math.floor(i / 25)}: ${error}`);
        }
      }
    }

    await logAudit('BULK_IMPORT', { tableType, imported, failed }, 'user', event.requestContext.identity.sourceIp);

    return createResponse(200, { imported, failed, errors });
  } catch (error) {
    console.error('Error in bulk import:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

export async function handler(event: APIGatewayEvent): Promise<APIResponse> {
  console.log('Event:', JSON.stringify(event, null, 2));

  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }

  try {
    const path = event.path;
    const method = event.httpMethod;

    // Route: GET /resources
    if (method === 'GET' && path === '/resources') {
      return await handleGetResources(event);
    }

    // Route: GET /api/{tableIndex}
    if (method === 'GET' && path.match(/^\/api\/\d+$/)) {
      return await handleGetResources(event);
    }

    // Route: GET /api/{tableIndex}/{id}
    if (method === 'GET' && path.match(/^\/api\/\d+\/.+$/)) {
      return await handleGetResources(event);
    }

    // Route: POST /api/{tableIndex}
    if (method === 'POST' && path.match(/^\/api\/\d+$/) && !path.includes('/bulk')) {
      return await handleCreateResource(event);
    }

    // Route: POST /api/{tableIndex}/bulk
    if (method === 'POST' && path.match(/^\/api\/\d+\/bulk$/)) {
      return await handleBulkImport(event);
    }

    // Route: PUT /api/{tableIndex}/{id}
    if (method === 'PUT' && path.match(/^\/api\/\d+\/.+$/)) {
      return await handleUpdateResource(event);
    }

    // Route: DELETE /api/{tableIndex}/{id}
    if (method === 'DELETE' && path.match(/^\/api\/\d+\/.+$/)) {
      return await handleDeleteResource(event);
    }

    return createResponse(404, { error: 'Not found' });
  } catch (error) {
    console.error('Unhandled error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}