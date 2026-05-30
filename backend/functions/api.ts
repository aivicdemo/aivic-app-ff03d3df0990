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
  body?: string;
  headers: { [key: string]: string };
  requestContext: {
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

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
};

const TABLE_CONFIGS = {
  '0': { name: 'ログインユーザー', pk: 'USER', fields: ['userId', 'staffId', 'loginId', 'passwordHash', 'userName', 'email', 'permissionLevel', 'activeFlag', 'lastLoginAt', 'passwordChangedAt', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'] },
  '1': { name: '店舗', pk: 'STORE', fields: ['storeId', 'storeCode', 'storeName', 'storeNameKana', 'postalCode', 'address', 'phoneNumber', 'storeType', 'regionCode', 'openDate', 'closeDate', 'businessStatus', 'salesTarget', 'managerUserId', 'displayOrder', 'activeFlag', 'createdAt', 'updatedAt', 'createdById', 'updatedById'] },
  '2': { name: '売上データ', pk: 'SALES', fields: ['salesId', 'storeId', 'posRegisterId', 'salesDate', 'salesAmount', 'taxExcludedAmount', 'taxAmount', 'transactionNumber', 'paymentMethod', 'customerCount', 'itemCount', 'salesType', 'businessDate', 'receiptNumber', 'staffId', 'remarks', 'dataLinkageStatus', 'createdAt', 'updatedAt', 'createdBy'] },
  '3': { name: '操作履歴', pk: 'OPERATION_LOG', fields: ['operationLogId', 'userId', 'userName', 'storeId', 'operationType', 'targetTable', 'targetId', 'operationContent', 'beforeData', 'afterData', 'ipAddress', 'userAgent', 'operationResult', 'errorMessage', 'sessionId', 'operationAt'] },
  '4': { name: '立地データ', pk: 'LOCATION', fields: ['locationId', 'locationName', 'prefecture', 'city', 'address', 'latitude', 'longitude', 'locationType', 'populationDensity', 'nearestStation', 'distanceFromStation', 'competitorCount', 'rentMarketPrice', 'footTraffic', 'evaluationScore', 'status', 'remarks', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'] },
  '5': { name: '商圏分析結果', pk: 'TRADE_AREA_ANALYSIS', fields: ['tradeAreaAnalysisId', 'storeId', 'analysisName', 'analysisType', 'tradeAreaRadius', 'estimatedPopulation', 'householdCount', 'averageIncome', 'competitorCount', 'marketSize', 'salesForecast', 'analysisStatus', 'analysisExecutedAt', 'analysisCompletedAt', 'remarks', 'createdById', 'createdAt', 'updatedAt'] },
  '6': { name: '競合調査データ', pk: 'COMPETITOR_SURVEY', fields: ['competitorSurveyId', 'targetStoreName', 'competitorCompanyName', 'storeAddress', 'latitude', 'longitude', 'businessType', 'storeArea', 'employeeCount', 'businessHoursStart', 'businessHoursEnd', 'estimatedMonthlySales', 'estimatedCustomerCount', 'mainProductsServices', 'priceRange', 'strengths', 'weaknesses', 'surveyDate', 'surveyMethod', 'surveyor', 'surveyMemo', 'status', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'] },
  '7': { name: '候補地', pk: 'CANDIDATE_LOCATION', fields: ['candidateLocationId', 'candidateLocationName', 'prefecture', 'city', 'address', 'latitude', 'longitude', 'propertyType', 'area', 'rent', 'deposit', 'considerationStatus', 'priority', 'expectedSales', 'investmentRecoveryPeriod', 'totalEvaluationScore', 'remarks', 'assignedUserId', 'createdAt', 'updatedAt', 'createdById', 'updatedById'] },
  '8': { name: '人口統計データ', pk: 'DEMOGRAPHIC_DATA', fields: ['demographicDataId', 'regionCode', 'regionName', 'statisticalYear', 'totalPopulation', 'householdCount', 'malePopulation', 'femalePopulation', 'youthPopulation', 'workingAgePopulation', 'elderlyPopulation', 'averageIncome', 'daytimePopulation', 'nighttimePopulation', 'populationDensity', 'dataSource', 'activeFlag', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'] },
  '9': { name: '消費者属性情報', pk: 'CONSUMER_ATTRIBUTE', fields: ['consumerAttributeId', 'tradeAreaId', 'ageGroup', 'gender', 'householdIncomeGroup', 'occupationCategory', 'householdComposition', 'population', 'compositionRatio', 'purchasingPowerIndex', 'lifestyle', 'dataAcquisitionMonth', 'dataSource', 'createdAt', 'updatedAt', 'createdById'] },
  '10': { name: '市場規模算出結果', pk: 'MARKET_SIZE_CALCULATION', fields: ['marketSizeCalculationId', 'candidateLocationId', 'tradeAreaAnalysisId', 'calculationName', 'targetArea', 'calculationMethod', 'totalMarketSize', 'acquirableMarketSize', 'marketShareRate', 'targetPopulation', 'householdCount', 'averageConsumptionUnitPrice', 'calculationBaseMonth', 'reliability', 'remarks', 'status', 'createdById', 'createdAt', 'updatedById', 'updatedAt'] },
  '11': { name: '競合サロン', pk: 'COMPETITOR_SALON', fields: ['competitorSalonId', 'salonName', 'chainName', 'address', 'latitude', 'longitude', 'businessStatus', 'openDate', 'closeDate', 'storeArea', 'seatCount', 'staffCount', 'serviceType', 'priceRange', 'competitorLevel', 'surveyStatus', 'remarks', 'createdAt', 'updatedAt', 'createdById', 'updatedById'] },
  '12': { name: '分析レポート', pk: 'ANALYSIS_REPORT', fields: ['reportId', 'reportName', 'reportType', 'targetStoreId', 'targetCandidateLocationId', 'analysisPeriodStart', 'analysisPeriodEnd', 'reportContent', 'conclusionSummary', 'recommendedAction', 'status', 'priority', 'publicFlag', 'createdById', 'approvedById', 'createdAt', 'updatedAt', 'approvedAt'] },
  '13': { name: 'データ収集履歴', pk: 'DATA_COLLECTION_HISTORY', fields: ['collectionHistoryId', 'dataSourceType', 'dataSourceName', 'storeId', 'collectionStartAt', 'collectionCompletedAt', 'collectionStatus', 'collectionCount', 'errorCount', 'targetPeriodStart', 'targetPeriodEnd', 'collectionMethod', 'errorMessage', 'processingDetails', 'dataQualityScore', 'nextCollectionScheduledAt', 'createdAt', 'updatedAt', 'createdById'] }
};

function createResponse(statusCode: number, body: any): APIGatewayResponse {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body)
  };
}

function getUserRole(event: APIGatewayEvent): Role {
  const role = event.headers['x-user-role'] || event.headers['X-User-Role'] || 'viewer';
  return validateRole(role) ? role : 'viewer';
}

function getUserId(event: APIGatewayEvent): string {
  return event.headers['x-user-id'] || event.headers['X-User-Id'] || 'system';
}

async function createAuditLog(userId: string, action: string, targetTable: string, targetId: string, ipAddress: string, userAgent: string, beforeData?: any, afterData?: any) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${crypto.randomUUID()}`,
    operationLogId: crypto.randomUUID(),
    userId,
    userName: userId,
    operationType: action,
    targetTable,
    targetId,
    operationContent: `${action} operation on ${targetTable}`,
    beforeData: beforeData ? JSON.stringify(beforeData) : null,
    afterData: afterData ? JSON.stringify(afterData) : null,
    ipAddress,
    userAgent,
    operationResult: 'success',
    operationAt: new Date().toISOString()
  };

  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const userRole = getUserRole(event);
    const userId = getUserId(event);
    const ipAddress = event.requestContext.identity.sourceIp;
    const userAgent = event.requestContext.identity.userAgent || '';

    // GET /resources エンドポイント
    if (event.httpMethod === 'GET' && event.path === '/resources') {
      if (!hasPermission(userRole, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index,
        name: config.name,
        pk: config.pk,
        fields: config.fields
      }));

      return createResponse(200, { resources });
    }

    // テーブル操作のルーティング
    const pathMatch = event.path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(\w+))?$/);
    if (!pathMatch) {
      return createResponse(404, { error: 'Not found' });
    }

    const [, tableIndex, action, subAction] = pathMatch;
    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }

    // 一括インポートエンドポイント
    if (event.httpMethod === 'POST' && action === 'bulk') {
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
      const now = new Date().toISOString();

      // 25件ずつに分割してバッチ処理
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        const writeRequests = batch.map(item => {
          const id = item.id || crypto.randomUUID();
          return {
            PutRequest: {
              Item: {
                pk: tableConfig.pk,
                sk: id,
                id,
                ...item,
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

      // 監査ログ記録
      await createAuditLog(userId, 'BULK_IMPORT', tableConfig.name, tableConfig.pk, ipAddress, userAgent, null, { imported, failed });

      return createResponse(200, { imported, failed, errors });
    }

    // 一覧取得
    if (event.httpMethod === 'GET' && !action) {
      if (!hasPermission(userRole, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const result = await docClient.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'pk = :pk',
        ExpressionAttributeValues: {
          ':pk': tableConfig.pk
        }
      }));

      return createResponse(200, { items: result.Items || [] });
    }

    // 詳細取得
    if (event.httpMethod === 'GET' && action) {
      if (!hasPermission(userRole, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: action
        }
      }));

      if (!result.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      return createResponse(200, result.Item);
    }

    // 登録・更新
    if (event.httpMethod === 'POST' || event.httpMethod === 'PUT') {
      if (!hasPermission(userRole, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const body = JSON.parse(event.body || '{}');
      const now = new Date().toISOString();
      const id = action || body.id || crypto.randomUUID();

      // 既存データの取得（更新の場合）
      let existingItem = null;
      if (event.httpMethod === 'PUT' || action) {
        const result = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.pk,
            sk: id
          }
        }));
        existingItem = result.Item;
      }

      const item = {
        pk: tableConfig.pk,
        sk: id,
        id,
        ...body,
        updatedAt: now,
        updatedBy: userId
      };

      if (!existingItem) {
        item.createdAt = now;
        item.createdBy = userId;
      } else {
        item.createdAt = existingItem.createdAt;
        item.createdBy = existingItem.createdBy;
      }

      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      }));

      // 監査ログ記録
      await createAuditLog(userId, existingItem ? 'UPDATE' : 'CREATE', tableConfig.name, id, ipAddress, userAgent, existingItem, item);

      return createResponse(200, item);
    }

    // 削除
    if (event.httpMethod === 'DELETE' && action) {
      if (!hasPermission(userRole, 'delete')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      // 削除前にデータを取得
      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: action
        }
      }));

      if (!result.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      await docClient.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: action
        }
      }));

      // 監査ログ記録
      await createAuditLog(userId, 'DELETE', tableConfig.name, action, ipAddress, userAgent, result.Item, null);

      return createResponse(200, { message: 'Item deleted successfully' });
    }

    return createResponse(405, { error: 'Method not allowed' });

  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};