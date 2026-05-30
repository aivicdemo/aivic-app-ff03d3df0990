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

const tableConfigs = {
  0: { pk: 'USER', name: 'ログインユーザー' },
  1: { pk: 'STORE', name: '店舗' },
  2: { pk: 'SALES', name: '売上データ' },
  3: { pk: 'AUDIT', name: '操作履歴' },
  4: { pk: 'LOCATION', name: '立地データ' },
  5: { pk: 'TRADE_AREA', name: '商圏分析結果' },
  6: { pk: 'COMPETITOR_SURVEY', name: '競合調査データ' },
  7: { pk: 'CANDIDATE_SITE', name: '候補地' },
  8: { pk: 'POPULATION_STATS', name: '人口統計データ' },
  9: { pk: 'CONSUMER_ATTRIBUTES', name: '消費者属性情報' },
  10: { pk: 'MARKET_SIZE_RESULT', name: '市場規模算出結果' },
  11: { pk: 'COMPETITOR_SALON', name: '競合サロン' },
  12: { pk: 'ANALYSIS_REPORT', name: '分析レポート' },
  13: { pk: 'DATA_COLLECTION_HISTORY', name: 'データ収集履歴' }
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

async function createAuditLog(userId: string, action: string, details: any, ip: string, userAgent?: string) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    operationHistoryId: randomUUID(),
    userId,
    userName: userId,
    operationType: action,
    operationContent: JSON.stringify(details),
    ipAddress: ip,
    userAgent: userAgent || '',
    operationResult: '成功',
    operationDateTime: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
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

function validateRequired(data: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (!data[field]) {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function getRequiredFields(tableIndex: number): string[] {
  const fieldMap: { [key: number]: string[] } = {
    0: ['userId', 'loginId', 'passwordHash', 'userName', 'email', 'permissionLevel', 'activeFlag'],
    1: ['storeId', 'storeCode', 'storeName', 'storeCategory', 'businessStatus', 'validFlag'],
    2: ['salesId', 'storeId', 'posRegisterId', 'salesDate', 'salesAmount', 'taxExcludedAmount', 'consumptionTaxAmount', 'transactionNumber', 'paymentMethod', 'customerCount', 'productCount', 'salesCategory', 'businessDate', 'dataLinkageStatus'],
    3: ['operationHistoryId', 'userId', 'userName', 'operationType', 'operationContent', 'ipAddress', 'operationResult', 'operationDateTime'],
    4: ['locationId', 'locationName', 'prefecture', 'municipality', 'address', 'locationType', 'status'],
    5: ['tradeAreaAnalysisResultId', 'storeId', 'analysisName', 'analysisType', 'tradeAreaRadius', 'analysisStatus', 'analysisExecutionDateTime'],
    6: ['competitorSurveyId', 'targetStoreName', 'competitorCompanyName', 'storeAddress', 'businessType', 'surveyDate', 'surveyMethod', 'surveyor', 'status'],
    7: ['candidateSiteId', 'candidateSiteName', 'prefecture', 'municipality', 'address', 'propertyType', 'considerationStatus', 'priority', 'personInChargeId'],
    8: ['populationStatsId', 'regionCode', 'regionName', 'statisticalYear', 'totalPopulation', 'householdCount', 'dataSource', 'validFlag'],
    9: ['consumerAttributeId', 'tradeAreaId', 'ageGroup', 'gender', 'householdIncomeGroup', 'occupationCategory', 'householdComposition', 'population', 'compositionRatio', 'dataAcquisitionYearMonth', 'dataSource'],
    10: ['marketSizeResultId', 'calculationName', 'calculationTargetArea', 'calculationMethod', 'totalMarketSize', 'targetPopulation', 'calculationBaseYearMonth', 'status'],
    11: ['competitorSalonId', 'salonName', 'address', 'businessStatus', 'serviceType', 'priceRange', 'competitorLevel', 'surveyStatus'],
    12: ['reportId', 'reportName', 'reportType', 'analysisStartDate', 'analysisEndDate', 'reportContent', 'conclusionSummary', 'status', 'priority', 'publicFlag'],
    13: ['collectionHistoryId', 'dataSourceType', 'dataSourceName', 'collectionStartDateTime', 'collectionStatus', 'collectionMethod']
  };
  return fieldMap[tableIndex] || [];
}

function addTimestamps(item: any, isUpdate = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

function addId(item: any, tableIndex: number): any {
  const config = tableConfigs[tableIndex as keyof typeof tableConfigs];
  if (!config) return item;

  item.pk = config.pk;
  if (!item.sk) {
    item.sk = randomUUID();
  }
  return item;
}

export const handler = async (event: APIGatewayEvent): Promise<APIResponse> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const userRole = extractUserRole(event);
    const pathParts = event.path.split('/').filter(p => p);
    const ip = event.requestContext.identity.sourceIp;
    const userAgent = event.requestContext.identity.userAgent;

    if (event.path === '/resources' && event.httpMethod === 'GET') {
      if (!hasPermission(userRole, 'resources', 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const resources = Object.entries(tableConfigs).map(([index, config]) => ({
        index: parseInt(index),
        name: config.name,
        pk: config.pk
      }));

      return createResponse(200, { resources });
    }

    if (pathParts.length >= 2 && pathParts[0] === 'api') {
      const tableIndex = parseInt(pathParts[1]);
      const config = tableConfigs[tableIndex as keyof typeof tableConfigs];
      
      if (!config) {
        return createResponse(404, { error: 'Table not found' });
      }

      const isBulkEndpoint = pathParts[2] === 'bulk';
      const resourceId = pathParts[2] && !isBulkEndpoint ? pathParts[2] : null;

      if (isBulkEndpoint && event.httpMethod === 'POST') {
        if (!hasPermission(userRole, config.pk, 'bulk')) {
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

        const chunks = [];
        for (let i = 0; i < items.length; i += 25) {
          chunks.push(items.slice(i, i + 25));
        }

        for (const chunk of chunks) {
          const writeRequests = [];
          
          for (const item of chunk) {
            const validationErrors = validateRequired(item, requiredFields);
            if (validationErrors.length > 0) {
              failed++;
              errors.push(...validationErrors);
              continue;
            }

            const processedItem = addTimestamps(addId({ ...item }, tableIndex));
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

        await createAuditLog(
          'system',
          'BULK_IMPORT',
          { table: config.name, imported, failed },
          ip,
          userAgent
        );

        return createResponse(200, { imported, failed, errors });
      }

      switch (event.httpMethod) {
        case 'GET':
          if (!hasPermission(userRole, config.pk, 'read')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          if (resourceId) {
            const result = await docClient.send(new GetCommand({
              TableName: TABLE_NAME,
              Key: { pk: config.pk, sk: resourceId }
            }));
            
            if (!result.Item) {
              return createResponse(404, { error: 'Resource not found' });
            }
            
            return createResponse(200, result.Item);
          } else {
            const result = await docClient.send(new ScanCommand({
              TableName: TABLE_NAME,
              FilterExpression: 'pk = :pk',
              ExpressionAttributeValues: { ':pk': config.pk }
            }));
            
            return createResponse(200, { items: result.Items || [] });
          }

        case 'POST':
          if (!hasPermission(userRole, config.pk, 'create')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          const createBody = JSON.parse(event.body || '{}');
          const createValidationErrors = validateRequired(createBody, getRequiredFields(tableIndex));
          
          if (createValidationErrors.length > 0) {
            return createResponse(400, { errors: createValidationErrors });
          }

          const newItem = addTimestamps(addId({ ...createBody }, tableIndex));
          
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: newItem
          }));

          await createAuditLog(
            userRole,
            'CREATE',
            { table: config.name, id: newItem.sk },
            ip,
            userAgent
          );

          return createResponse(201, newItem);

        case 'PUT':
          if (!resourceId) {
            return createResponse(400, { error: 'Resource ID required for update' });
          }
          
          if (!hasPermission(userRole, config.pk, 'update')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          const updateBody = JSON.parse(event.body || '{}');
          const updateValidationErrors = validateRequired(updateBody, getRequiredFields(tableIndex));
          
          if (updateValidationErrors.length > 0) {
            return createResponse(400, { errors: updateValidationErrors });
          }

          const existingItem = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: config.pk, sk: resourceId }
          }));

          if (!existingItem.Item) {
            return createResponse(404, { error: 'Resource not found' });
          }

          const updatedItem = addTimestamps({ 
            ...existingItem.Item, 
            ...updateBody, 
            pk: config.pk, 
            sk: resourceId 
          }, true);

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          }));

          await createAuditLog(
            userRole,
            'UPDATE',
            { table: config.name, id: resourceId },
            ip,
            userAgent
          );

          return createResponse(200, updatedItem);

        case 'DELETE':
          if (!resourceId) {
            return createResponse(400, { error: 'Resource ID required for deletion' });
          }
          
          if (!hasPermission(userRole, config.pk, 'delete')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          const deleteItem = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: config.pk, sk: resourceId }
          }));

          if (!deleteItem.Item) {
            return createResponse(404, { error: 'Resource not found' });
          }

          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { pk: config.pk, sk: resourceId }
          }));

          await createAuditLog(
            userRole,
            'DELETE',
            { table: config.name, id: resourceId },
            ip,
            userAgent
          );

          return createResponse(200, { message: 'Resource deleted successfully' });

        default:
          return createResponse(405, { error: 'Method not allowed' });
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });

  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};