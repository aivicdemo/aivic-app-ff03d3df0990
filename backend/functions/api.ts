import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractRoleFromEvent, Role } from './rbac';
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
  requestContext?: {
    requestId: string;
    identity: {
      sourceIp: string;
      userAgent: string;
    };
  };
}

interface APIGatewayResponse {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;
}

const TABLES = {
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

async function createAuditLog(event: APIGatewayEvent, action: string, details: any) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: extractRoleFromEvent(event),
    action,
    details: JSON.stringify(details),
    ipAddress: event.requestContext?.identity?.sourceIp || 'unknown',
    userAgent: event.requestContext?.identity?.userAgent || 'unknown',
    timestamp: new Date().toISOString(),
    requestId: event.requestContext?.requestId || 'unknown'
  };

  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: auditLog
    }));
  } catch (error) {
    console.error('Failed to create audit log:', error);
  }
}

function validateRequired(item: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (!item[field]) {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function getRequiredFields(tableIndex: string): string[] {
  const fieldMap: { [key: string]: string[] } = {
    '0': ['userId', 'loginId', 'passwordHash', 'userName', 'email', 'permissionLevel', 'activeFlag'],
    '1': ['storeId', 'storeCode', 'storeName', 'storeCategory', 'businessStatus', 'validFlag'],
    '2': ['salesId', 'storeId', 'posRegisterId', 'salesDate', 'salesAmount', 'taxExcludedAmount', 'taxAmount', 'transactionNumber', 'paymentMethod', 'customerCount', 'itemCount', 'salesCategory', 'businessDate', 'dataLinkageStatus'],
    '3': ['operationHistoryId', 'userId', 'userName', 'operationType', 'operationContent', 'ipAddress', 'operationResult', 'operationDateTime'],
    '4': ['locationId', 'locationName', 'prefecture', 'municipality', 'address', 'locationType', 'status'],
    '5': ['marketAnalysisResultId', 'storeId', 'analysisName', 'analysisType', 'marketRadius', 'analysisStatus', 'analysisExecutionDateTime'],
    '6': ['competitorSurveyId', 'targetStoreName', 'competitorCompanyName', 'storeAddress', 'businessType', 'surveyDate', 'surveyMethod', 'surveyor', 'status'],
    '7': ['candidateLocationId', 'candidateLocationName', 'prefecture', 'municipality', 'address', 'propertyType', 'considerationStatus', 'priority', 'personInChargeId'],
    '8': ['populationStatisticsId', 'regionCode', 'regionName', 'statisticsYear', 'totalPopulation', 'householdCount', 'dataSource', 'validFlag'],
    '9': ['consumerAttributeId', 'marketAreaId', 'ageGroup', 'gender', 'householdIncomeGroup', 'occupationCategory', 'householdComposition', 'population', 'compositionRatio', 'dataAcquisitionYearMonth', 'dataSource'],
    '10': ['marketSizeResultId', 'calculationName', 'targetArea', 'calculationMethod', 'totalMarketSize', 'targetPopulation', 'baseYearMonth', 'status'],
    '11': ['competitorSalonId', 'salonName', 'address', 'businessStatus', 'serviceType', 'priceRange', 'competitorLevel', 'surveyStatus'],
    '12': ['reportId', 'reportName', 'reportType', 'analysisStartDate', 'analysisEndDate', 'reportContent', 'conclusionSummary', 'status', 'priority', 'publicFlag'],
    '13': ['collectionHistoryId', 'dataSourceType', 'dataSourceName', 'collectionStartDateTime', 'collectionStatus', 'collectionMethod']
  };
  return fieldMap[tableIndex] || [];
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const role = extractRoleFromEvent(event);
    const path = event.path;
    const method = event.httpMethod;

    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(role, 'resources', 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const resources = {
        tables: Object.entries(TABLES).map(([index, table]) => ({
          index,
          name: table.name,
          pk: table.pk
        })),
        permissions: {
          admin: ['create', 'read', 'update', 'delete', 'bulk'],
          operator: ['create', 'read', 'update', 'bulk'],
          viewer: ['read']
        },
        currentRole: role
      };

      return createResponse(200, resources);
    }

    const pathMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(bulk))?$/);
    if (!pathMatch) {
      return createResponse(404, { error: 'Endpoint not found' });
    }

    const [, tableIndex, itemId, bulkFlag] = pathMatch;
    const table = TABLES[tableIndex as keyof typeof TABLES];
    
    if (!table) {
      return createResponse(404, { error: 'Table not found' });
    }

    if (bulkFlag === 'bulk' && method === 'POST') {
      if (!hasPermission(role, table.name, 'bulk')) {
        return createResponse(403, { error: 'Insufficient permissions for bulk operations' });
      }

      const body = JSON.parse(event.body || '{}');
      const items = body.items || [];

      if (!Array.isArray(items)) {
        return createResponse(400, { error: 'Items must be an array' });
      }

      let imported = 0;
      let failed = 0;
      const errors: string[] = [];
      const requiredFields = getRequiredFields(tableIndex);

      const batches = [];
      for (let i = 0; i < items.length; i += 25) {
        batches.push(items.slice(i, i + 25));
      }

      for (const batch of batches) {
        const writeRequests = [];
        
        for (const item of batch) {
          const validationErrors = validateRequired(item, requiredFields);
          if (validationErrors.length > 0) {
            failed++;
            errors.push(`Item validation failed: ${validationErrors.join(', ')}`);
            continue;
          }

          const now = new Date().toISOString();
          const processedItem = {
            ...item,
            pk: table.pk,
            sk: item.id || randomUUID(),
            createdAt: now,
            updatedAt: now,
            createdBy: role,
            updatedBy: role
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

      await createAuditLog(event, 'BULK_IMPORT', {
        table: table.name,
        imported,
        failed,
        totalItems: items.length
      });

      return createResponse(200, { imported, failed, errors });
    }

    switch (method) {
      case 'GET':
        if (!hasPermission(role, table.name, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (itemId) {
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: table.pk, sk: itemId }
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
              ':pk': table.pk
            }
          }));

          return createResponse(200, { items: result.Items || [] });
        }

      case 'POST':
        if (!hasPermission(role, table.name, 'create')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const createBody = JSON.parse(event.body || '{}');
        const requiredFields = getRequiredFields(tableIndex);
        const validationErrors = validateRequired(createBody, requiredFields);
        
        if (validationErrors.length > 0) {
          return createResponse(400, { error: 'Validation failed', details: validationErrors });
        }

        const now = new Date().toISOString();
        const newItem = {
          ...createBody,
          pk: table.pk,
          sk: createBody.id || randomUUID(),
          createdAt: now,
          updatedAt: now,
          createdBy: role,
          updatedBy: role
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: newItem
        }));

        await createAuditLog(event, 'CREATE', {
          table: table.name,
          itemId: newItem.sk,
          data: newItem
        });

        return createResponse(201, newItem);

      case 'PUT':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID is required for updates' });
        }

        if (!hasPermission(role, table.name, 'update')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const updateBody = JSON.parse(event.body || '{}');
        const existingItem = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk: table.pk, sk: itemId }
        }));

        if (!existingItem.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        const updatedItem = {
          ...existingItem.Item,
          ...updateBody,
          pk: table.pk,
          sk: itemId,
          updatedAt: new Date().toISOString(),
          updatedBy: role
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));

        await createAuditLog(event, 'UPDATE', {
          table: table.name,
          itemId,
          oldData: existingItem.Item,
          newData: updatedItem
        });

        return createResponse(200, updatedItem);

      case 'DELETE':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID is required for deletion' });
        }

        if (!hasPermission(role, table.name, 'delete')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const itemToDelete = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk: table.pk, sk: itemId }
        }));

        if (!itemToDelete.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { pk: table.pk, sk: itemId }
        }));

        await createAuditLog(event, 'DELETE', {
          table: table.name,
          itemId,
          deletedData: itemToDelete.Item
        });

        return createResponse(200, { message: 'Item deleted successfully' });

      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' });
  }
};