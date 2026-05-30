export type Role = 'admin' | 'operator' | 'viewer';

export interface Permission {
  resource: string;
  actions: string[];
}

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: [
    { resource: '*', actions: ['*'] }
  ],
  operator: [
    { resource: 'users', actions: ['read', 'create', 'update'] },
    { resource: 'stores', actions: ['read', 'create', 'update'] },
    { resource: 'sales', actions: ['read', 'create', 'update'] },
    { resource: 'audit', actions: ['read'] },
    { resource: 'locations', actions: ['read', 'create', 'update'] },
    { resource: 'market-analysis', actions: ['read', 'create', 'update'] },
    { resource: 'competitor-research', actions: ['read', 'create', 'update'] },
    { resource: 'candidate-locations', actions: ['read', 'create', 'update'] },
    { resource: 'demographics', actions: ['read', 'create', 'update'] },
    { resource: 'consumer-attributes', actions: ['read', 'create', 'update'] },
    { resource: 'market-size', actions: ['read', 'create', 'update'] },
    { resource: 'competitor-salons', actions: ['read', 'create', 'update'] },
    { resource: 'analysis-reports', actions: ['read', 'create', 'update'] },
    { resource: 'data-collection', actions: ['read', 'create', 'update'] },
    { resource: 'bulk', actions: ['create'] }
  ],
  viewer: [
    { resource: 'users', actions: ['read'] },
    { resource: 'stores', actions: ['read'] },
    { resource: 'sales', actions: ['read'] },
    { resource: 'audit', actions: ['read'] },
    { resource: 'locations', actions: ['read'] },
    { resource: 'market-analysis', actions: ['read'] },
    { resource: 'competitor-research', actions: ['read'] },
    { resource: 'candidate-locations', actions: ['read'] },
    { resource: 'demographics', actions: ['read'] },
    { resource: 'consumer-attributes', actions: ['read'] },
    { resource: 'market-size', actions: ['read'] },
    { resource: 'competitor-salons', actions: ['read'] },
    { resource: 'analysis-reports', actions: ['read'] },
    { resource: 'data-collection', actions: ['read'] }
  ]
};

export function hasPermission(role: Role, resource: string, action: string): boolean {
  const permissions = ROLE_PERMISSIONS[role];
  
  return permissions.some(permission => {
    const resourceMatch = permission.resource === '*' || permission.resource === resource;
    const actionMatch = permission.actions.includes('*') || permission.actions.includes(action);
    return resourceMatch && actionMatch;
  });
}

export function extractUserRole(event: any): Role | null {
  const authHeader = event.headers?.Authorization || event.headers?.authorization;
  if (!authHeader) return null;
  
  try {
    const token = authHeader.replace('Bearer ', '');
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return payload.role as Role;
  } catch {
    return null;
  }
}

export function extractUserId(event: any): string | null {
  const authHeader = event.headers?.Authorization || event.headers?.authorization;
  if (!authHeader) return null;
  
  try {
    const token = authHeader.replace('Bearer ', '');
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return payload.userId || payload.sub;
  } catch {
    return null;
  }
}