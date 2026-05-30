export type Role = 'admin' | 'operator' | 'viewer';

export interface User {
  id: string;
  role: Role;
  permissions: string[];
}

export const PERMISSIONS = {
  READ_USERS: 'read:users',
  WRITE_USERS: 'write:users',
  READ_STORES: 'read:stores',
  WRITE_STORES: 'write:stores',
  READ_SALES: 'read:sales',
  WRITE_SALES: 'write:sales',
  READ_OPERATION_LOGS: 'read:operation_logs',
  WRITE_OPERATION_LOGS: 'write:operation_logs',
  READ_LOCATION_DATA: 'read:location_data',
  WRITE_LOCATION_DATA: 'write:location_data',
  READ_TRADE_AREA_ANALYSIS: 'read:trade_area_analysis',
  WRITE_TRADE_AREA_ANALYSIS: 'write:trade_area_analysis',
  READ_COMPETITOR_RESEARCH: 'read:competitor_research',
  WRITE_COMPETITOR_RESEARCH: 'write:competitor_research',
  READ_CANDIDATE_LOCATIONS: 'read:candidate_locations',
  WRITE_CANDIDATE_LOCATIONS: 'write:candidate_locations',
  READ_POPULATION_DATA: 'read:population_data',
  WRITE_POPULATION_DATA: 'write:population_data',
  READ_CONSUMER_ATTRIBUTES: 'read:consumer_attributes',
  WRITE_CONSUMER_ATTRIBUTES: 'write:consumer_attributes',
  READ_MARKET_SIZE_RESULTS: 'read:market_size_results',
  WRITE_MARKET_SIZE_RESULTS: 'write:market_size_results',
  READ_COMPETITOR_SALONS: 'read:competitor_salons',
  WRITE_COMPETITOR_SALONS: 'write:competitor_salons',
  READ_ANALYSIS_REPORTS: 'read:analysis_reports',
  WRITE_ANALYSIS_REPORTS: 'write:analysis_reports',
  READ_DATA_COLLECTION_HISTORY: 'read:data_collection_history',
  WRITE_DATA_COLLECTION_HISTORY: 'write:data_collection_history',
  BULK_IMPORT: 'bulk:import'
} as const;

export const ROLE_PERMISSIONS: Record<Role, string[]> = {
  admin: Object.values(PERMISSIONS),
  operator: [
    PERMISSIONS.READ_USERS,
    PERMISSIONS.READ_STORES,
    PERMISSIONS.WRITE_STORES,
    PERMISSIONS.READ_SALES,
    PERMISSIONS.WRITE_SALES,
    PERMISSIONS.READ_OPERATION_LOGS,
    PERMISSIONS.WRITE_OPERATION_LOGS,
    PERMISSIONS.READ_LOCATION_DATA,
    PERMISSIONS.WRITE_LOCATION_DATA,
    PERMISSIONS.READ_TRADE_AREA_ANALYSIS,
    PERMISSIONS.WRITE_TRADE_AREA_ANALYSIS,
    PERMISSIONS.READ_COMPETITOR_RESEARCH,
    PERMISSIONS.WRITE_COMPETITOR_RESEARCH,
    PERMISSIONS.READ_CANDIDATE_LOCATIONS,
    PERMISSIONS.WRITE_CANDIDATE_LOCATIONS,
    PERMISSIONS.READ_POPULATION_DATA,
    PERMISSIONS.WRITE_POPULATION_DATA,
    PERMISSIONS.READ_CONSUMER_ATTRIBUTES,
    PERMISSIONS.WRITE_CONSUMER_ATTRIBUTES,
    PERMISSIONS.READ_MARKET_SIZE_RESULTS,
    PERMISSIONS.WRITE_MARKET_SIZE_RESULTS,
    PERMISSIONS.READ_COMPETITOR_SALONS,
    PERMISSIONS.WRITE_COMPETITOR_SALONS,
    PERMISSIONS.READ_ANALYSIS_REPORTS,
    PERMISSIONS.WRITE_ANALYSIS_REPORTS,
    PERMISSIONS.READ_DATA_COLLECTION_HISTORY,
    PERMISSIONS.WRITE_DATA_COLLECTION_HISTORY,
    PERMISSIONS.BULK_IMPORT
  ],
  viewer: [
    PERMISSIONS.READ_USERS,
    PERMISSIONS.READ_STORES,
    PERMISSIONS.READ_SALES,
    PERMISSIONS.READ_OPERATION_LOGS,
    PERMISSIONS.READ_LOCATION_DATA,
    PERMISSIONS.READ_TRADE_AREA_ANALYSIS,
    PERMISSIONS.READ_COMPETITOR_RESEARCH,
    PERMISSIONS.READ_CANDIDATE_LOCATIONS,
    PERMISSIONS.READ_POPULATION_DATA,
    PERMISSIONS.READ_CONSUMER_ATTRIBUTES,
    PERMISSIONS.READ_MARKET_SIZE_RESULTS,
    PERMISSIONS.READ_COMPETITOR_SALONS,
    PERMISSIONS.READ_ANALYSIS_REPORTS,
    PERMISSIONS.READ_DATA_COLLECTION_HISTORY
  ]
};

export function hasPermission(user: User, permission: string): boolean {
  return user.permissions.includes(permission);
}

export function getUserFromEvent(event: any): User | null {
  try {
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    if (!authHeader) return null;
    
    const token = authHeader.replace('Bearer ', '');
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    
    const role = payload.role as Role;
    if (!role || !ROLE_PERMISSIONS[role]) return null;
    
    return {
      id: payload.sub || payload.userId,
      role,
      permissions: ROLE_PERMISSIONS[role]
    };
  } catch {
    return null;
  }
}