import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { hasPermission, validateRole, Role } from './rbac';
import * as crypto from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface LoginUser {
  userId: string;
  staffId?: string;
  loginId: string;
  passwordHash: string;
  userName: string;
  email: string;
  permissionLevel: string;
  activeFlag: boolean;
  lastLoginAt?: string;
  passwordChangedAt?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

interface Store {
  storeId: string;
  storeCode: string;
  storeName: string;
  storeNameKana?: string;
  postalCode?: string;
  address?: string;
  phoneNumber?: string;
  storeType: string;
  regionCode?: string;
  openDate?: string;
  closeDate?: string;
  businessStatus: string;
  salesTarget?: number;
  managerUserId?: string;
  displayOrder?: number;
  activeFlag: boolean;
  createdAt: string;
  updatedAt: string;
  createdById: string;
  updatedById: string;
}

interface SalesData {
  salesId: string;
  storeId: string;
  posRegisterId: string;
  salesDate: string;
  salesAmount: number;
  taxExcludedAmount: number;
  taxAmount: number;
  transactionNumber: string;
  paymentMethod: string;
  customerCount: number;
  itemCount: number;
  salesType: string;
  businessDate: string;
  receiptNumber?: string;
  staffId?: string;
  memo?: string;
  dataLinkageStatus: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

interface OperationHistory {
  operationHistoryId: string;
  userId: string;
  userName: string;
  storeId?: string;
  operationType: string;
  targetTable?: string;
  targetId?: string;
  operationContent: string;
  beforeData?: string;
  afterData?: string;
  ipAddress: string;
  userAgent?: string;
  operationResult: string;
  errorMessage?: string;
  sessionId?: string;
  operationAt: string;
}

interface LocationData {
  locationId: string;
  locationName: string;
  prefecture: string;
  city: string;
  address: string;
  latitude?: string;
  longitude?: string;
  locationType: string;
  populationDensity?: number;
  nearestStation?: string;
  stationDistance?: number;
  competitorCount?: number;
  rentMarketPrice?: number;
  footTraffic?: number;
  evaluationScore?: number;
  status: string;
  memo?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

interface TradeAreaAnalysisResult {
  tradeAreaAnalysisResultId: string;
  storeId: string;
  analysisName: string;
  analysisType: string;
  tradeAreaRadius: number;
  estimatedPopulation?: number;
  householdCount?: number;
  averageIncome?: number;
  competitorCount?: number;
  marketSize?: number;
  salesForecast?: number;
  analysisStatus: string;
  analysisExecutedAt: string;
  analysisCompletedAt?: string;
  memo?: string;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

interface CompetitorSurveyData {
  competitorSurveyId: string;
  targetStoreName: string;
  competitorCompanyName: string;
  storeAddress: string;
  latitude?: string;
  longitude?: string;
  businessType: string;
  storeArea?: number;
  employeeCount?: number;
  businessHoursStart?: string;
  businessHoursEnd?: string;
  estimatedMonthlySales?: number;
  estimatedCustomerCount?: number;
  mainProductsServices?: string;
  priceRange?: string;
  strengths?: string;
  weaknesses?: string;
  surveyDate: string;
  surveyMethod: string;
  surveyor: string;
  surveyMemo?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

interface CandidateLocation {
  candidateLocationId: string;
  candidateLocationName: string;
  prefecture: string;
  city: string;
  address: string;
  latitude?: string;
  longitude?: string;
  propertyType: string;
  area?: number;
  rent?: number;
  deposit?: number;
  considerationStatus: string;
  priority: string;
  expectedSales?: number;
  investmentRecoveryPeriod?: number;
  totalEvaluationScore?: number;
  memo?: string;
  assigneeId: string;
  createdAt: string;
  updatedAt: string;
  createdById: string;
  updatedById: string;
}

interface PopulationStatisticsData {
  populationStatisticsDataId: string;
  regionCode: string;
  regionName: string;
  statisticsYear: number;
  totalPopulation: number;
  householdCount: number;
  malePopulation?: number;
  femalePopulation?: number;
  youthPopulation?: number;
  workingAgePopulation?: number;
  elderlyPopulation?: number;
  averageIncome?: number;
  daytimePopulation?: number;
  nighttimePopulation?: number;
  populationDensity?: number;
  dataSource: string;
  activeFlag: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

interface ConsumerAttributeInfo {
  consumerAttributeId: string;
  tradeAreaId: string;
  ageGroup: string;
  gender: string;
  householdIncomeGroup: string;
  occupationCategory: string;
  householdComposition: string;
  count: number;
  compositionRatio: number;
  purchasingPowerIndex?: number;
  lifestyle?: string;
  dataAcquisitionYearMonth: string;
  dataSource: string;
  createdAt: string;
  updatedAt: string;
  createdById: string;
}

interface MarketSizeCalculationResult {
  marketSizeCalculationResultId: string;
  candidateLocationId?: string;
  tradeAreaAnalysisResultId?: string;
  calculationName: string;
  targetArea: string;
  calculationMethod: string;
  totalMarketSize: number;
  acquirableMarketSize?: number;
  marketShareRate?: number;
  targetPopulation: number;
  householdCount?: number;
  averageConsumptionUnitPrice?: number;
  calculationBaseYearMonth: string;
  reliability?: string;
  memo?: string;
  status: string;
  createdById: string;
  createdAt: string;
  updatedById?: string;
  updatedAt: string;
}

interface CompetitorSalon {
  competitorSalonId: string;
  salonName: string;
  chainName?: string;
  address: string;
  latitude?: string;
  longitude?: string;
  businessStatus: string;
  openDate?: string;
  closeDate?: string;
  storeArea?: number;
  seatCount?: number;
  staffCount?: number;
  serviceType?: string;
  priceRange?: string;
  competitorLevel: string;
  surveyStatus: string;
  memo?: string;
  createdAt: string;
  updatedAt: string;
  createdById: string;
  updatedById: string;
}

interface AnalysisReport {
  reportId: string;
  reportName: string;
  reportType: string;
  targetStoreId?: string;
  targetCandidateLocationId?: string;
  analysisStartDate: string;
  analysisEndDate: string;
  reportContent: string;
  conclusionSummary: string;
  recommendedAction?: string;
  status: string;
  priority: string;
  publicFlag: boolean;
  createdById: string;
  approvedById?: string;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
}

interface DataCollectionHistory {
  collectionHistoryId: string;
  dataSourceType: string;
  dataSourceName: string;
  storeId?: string;
  collectionStartAt: string;
  collectionCompletedAt?: string;
  collectionStatus: string;
  collectionCount?: number;
  errorCount?: number;
  targetPeriodStartDate?: string;
  targetPeriodEndDate?: string;
  collectionMethod: string;
  errorMessage?: string;
  processingDetails?: string;
  dataQualityScore?: number;
  nextCollectionScheduledAt?: string;
  createdAt: string;
  updatedAt: string;
  createdById: string;
}

const TABLE_CONFIGS = {
  '0': { pk: 'LOGIN_USER', type: 'LoginUser' },
  '1': { pk: 'STORE', type: 'Store' },
  '2': { pk: 'SALES_DATA', type: 'SalesData' },
  '3': { pk: 'OPERATION_HISTORY', type: 'OperationHistory' },
  '4': { pk: 'LOCATION_DATA', type: 'LocationData' },
  '5': { pk: 'TRADE_AREA_ANALYSIS_RESULT', type: 'TradeAreaAnalysisResult' },
  '6': { pk: 'COMPETITOR_SURVEY_DATA', type: 'CompetitorSurveyData' },
  '7': { pk: 'CANDIDATE_LOCATION', type: 'CandidateLocation' },
  '8': { pk: 'POPULATION_STATISTICS_DATA', type: 'PopulationStatisticsData' },
  '9': { pk: 'CONSUMER_ATTRIBUTE_INFO', type: 'ConsumerAttributeInfo' },
  '10': { pk: 'MARKET_SIZE_CALCULATION_RESULT', type: 'MarketSizeCalculationResult' },
  '11': { pk: 'COMPETITOR_SALON', type: 'CompetitorSalon' },
  '12': { pk: 'ANALYSIS_REPORT', type: 'AnalysisReport' },
  '13': { pk: 'DATA_COLLECTION_HISTORY', type: 'DataCollectionHistory' }
};

function createAuditLog(userId: string, action: string, targetTable: string, targetId?: string, details?: any) {
  return {
    pk: 'AUDIT',
    sk: `${Date.now()}_${crypto.randomUUID()}`,
    userId,
    action,
    targetTable,
    targetId,
    details: details ? JSON.stringify(details) : undefined,
    timestamp: new Date().toISOString(),
    ipAddress: 'unknown'
  };
}

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
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

function getUserFromEvent(event: APIGatewayProxyEvent): { userId: string; role: Role } {
  const authHeader = event.headers.Authorization || event.headers.authorization;
  if (!authHeader) {
    throw new Error('Authorization header required');
  }
  
  try {
    const token = authHeader.replace('Bearer ', '');
    const decoded = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return {
      userId: decoded.sub || 'unknown',
      role: validateRole(decoded.role || 'viewer')
    };
  } catch {
    throw new Error('Invalid token');
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const { httpMethod, pathParameters, body } = event;
    const path = event.path || event.resource || '';
    
    if (httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    if (path === '/resources' && httpMethod === 'GET') {
      const { userId, role } = getUserFromEvent(event);
      
      if (!hasPermission(role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const resources = {
        loginUsers: [],
        stores: [],
        salesData: [],
        operationHistory: [],
        locationData: [],
        tradeAreaAnalysisResults: [],
        competitorSurveyData: [],
        candidateLocations: [],
        populationStatisticsData: [],
        consumerAttributeInfo: [],
        marketSizeCalculationResults: [],
        competitorSalons: [],
        analysisReports: [],
        dataCollectionHistory: []
      };

      for (const [index, config] of Object.entries(TABLE_CONFIGS)) {
        try {
          const command = new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: { ':pk': config.pk },
            Limit: 100
          });
          const result = await docClient.send(command);
          
          const key = Object.keys(resources)[parseInt(index)];
          (resources as any)[key] = result.Items || [];
        } catch (error) {
          console.error(`Error fetching ${config.type}:`, error);
        }
      }

      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: createAuditLog(userId, 'READ_ALL_RESOURCES', 'ALL_TABLES')
      }));

      return createResponse(200, resources);
    }

    const tableIndex = pathParameters?.tableIndex;
    const id = pathParameters?.id;
    
    if (!tableIndex || !TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS]) {
      return createResponse(404, { error: 'Table not found' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const { userId, role } = getUserFromEvent(event);

    if (path.includes('/bulk') && httpMethod === 'POST') {
      if (!hasPermission(role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions for bulk import' });
      }

      const requestBody = JSON.parse(body || '{}');
      const items = requestBody.items || [];
      
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
        const writeRequests = chunk.map((item: any) => {
          const now = new Date().toISOString();
          const itemWithMeta = {
            ...item,
            pk: config.pk,
            sk: item.id || crypto.randomUUID(),
            createdAt: now,
            updatedAt: now,
            createdBy: userId,
            updatedBy: userId
          };

          return {
            PutRequest: {
              Item: itemWithMeta
            }
          };
        });

        try {
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

      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: createAuditLog(userId, 'BULK_IMPORT', config.pk, undefined, { imported, failed })
      }));

      return createResponse(200, { imported, failed, errors });
    }

    switch (httpMethod) {
      case 'GET':
        if (!hasPermission(role, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (id) {
          const command = new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: config.pk, sk: id }
          });
          const result = await docClient.send(command);
          
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: createAuditLog(userId, 'READ', config.pk, id)
          }));

          return createResponse(200, result.Item);
        } else {
          const command = new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: { ':pk': config.pk }
          });
          const result = await docClient.send(command);

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: createAuditLog(userId, 'LIST', config.pk)
          }));

          return createResponse(200, { items: result.Items || [] });
        }

      case 'POST':
        if (!hasPermission(role, 'write')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const createData = JSON.parse(body || '{}');
        const newId = crypto.randomUUID();
        const now = new Date().toISOString();
        
        const newItem = {
          ...createData,
          pk: config.pk,
          sk: newId,
          createdAt: now,
          updatedAt: now,
          createdBy: userId,
          updatedBy: userId
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: newItem
        }));

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: createAuditLog(userId, 'CREATE', config.pk, newId, newItem)
        }));

        return createResponse(201, newItem);

      case 'PUT':
        if (!hasPermission(role, 'write')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (!id) {
          return createResponse(400, { error: 'ID required for update' });
        }

        const updateData = JSON.parse(body || '{}');
        const updatedItem = {
          ...updateData,
          pk: config.pk,
          sk: id,
          updatedAt: new Date().toISOString(),
          updatedBy: userId
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: createAuditLog(userId, 'UPDATE', config.pk, id, updatedItem)
        }));

        return createResponse(200, updatedItem);

      case 'DELETE':
        if (!hasPermission(role, 'delete')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (!id) {
          return createResponse(400, { error: 'ID required for delete' });
        }

        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { pk: config.pk, sk: id }
        }));

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: createAuditLog(userId, 'DELETE', config.pk, id)
        }));

        return createResponse(200, { message: 'Item deleted successfully' });

      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof Error) {
      if (error.message.includes('Authorization') || error.message.includes('token') || error.message.includes('role')) {
        return createResponse(401, { error: 'Unauthorized' });
      }
    }
    
    return createResponse(500, { error: 'Internal server error' });
  }
};