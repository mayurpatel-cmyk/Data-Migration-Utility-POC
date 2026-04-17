export interface NavigationItem {
  id: string;
  title: string;
  type: 'item' | 'collapse' | 'group';
  translate?: string;
  icon?: string;
  hidden?: boolean;
  url?: string;
  classes?: string;
  external?: boolean;
  target?: boolean;
  breadcrumbs?: boolean;
  children?: NavigationItem[];
  role?: string[];
  isMainParent?: boolean;
}

export const NavigationItems: NavigationItem[] = [
 {
  id: 'data-import',
  title: 'CSV/Excel Import',
  type: 'item',
  url: '/data-import', // This must match the path in AppRoutingModule
  icon: 'ti ti-file-upload',
  breadcrumbs: true
},
 {
  id: 'connection',
  title: 'Connection',
  type: 'item',
  url: '/connection', // This must match the path in AppRoutingModule
  icon: 'ti ti-file-upload',
  breadcrumbs: true
},

];
