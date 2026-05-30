export type UserRole = 'admin' | 'operator' | 'viewer';

export interface Permission {
  resource: string;
  action: 'create' | 'read' | 'update' | 'delete' | 'bulk';
}

const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  admin: [
    { resource: '*', action: 'create' },
    { resource: '*', action: 'read' },
    { resource: '*', action: 'update' },
    { resource: '*', action: 'delete' },
    { resource: '*', action: 'bulk' }
  ],
  operator: [
    { resource: '*', action: 'create' },
    { resource: '*', action: 'read' },
    { resource: '*', action: 'update' },
    { resource: '*', action: 'bulk' }
  ],
  viewer: [
    { resource: '*', action: 'read' }
  ]
};

export function hasPermission(role: UserRole, resource: string, action: Permission['action']): boolean {
  const permissions = ROLE_PERMISSIONS[role] || [];
  return permissions.some(p => 
    (p.resource === '*' || p.resource === resource) && p.action === action
  );
}

export function extractUserRole(event: any): UserRole {
  const role = event.requestContext?.authorizer?.role || event.headers?.['x-user-role'] || 'viewer';
  return ['admin', 'operator', 'viewer'].includes(role) ? role as UserRole : 'viewer';
}

export function extractUserId(event: any): string {
  return event.requestContext?.authorizer?.userId || event.headers?.['x-user-id'] || 'system';
}