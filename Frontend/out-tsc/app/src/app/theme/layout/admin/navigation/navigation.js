export const NavigationItems = [
    {
        id: 'connection',
        title: 'Connection',
        type: 'item',
        url: '/connection', // This must match the path in AppRoutingModule
        icon: 'ti ti-plug',
        breadcrumbs: true
    },
    {
        id: 'validation',
        title: 'DataValidation',
        type: 'item',
        url: '/data-validation', // This must match the path in AppRoutingModule
        icon: 'ti ti-shield-check',
        breadcrumbs: true
    },
    {
        id: 'data-import',
        title: 'CSV/Excel Import',
        type: 'item',
        url: '/data-import', // This must match the path in AppRoutingModule
        icon: 'ti ti-file-upload',
        breadcrumbs: true
    },
    {
        id: 'api-mapping',
        title: 'API Mapping',
        type: 'item',
        url: '/api-mapping',
        icon: 'ti ti-arrows-exchange',
        breadcrumbs: true
    },
    {
        id: 'migration-docs',
        title: 'Migration-Docs',
        type: 'item',
        url: '/migration-docs',
        icon: 'ti ti-book',
        breadcrumbs: true
    }
];
//# sourceMappingURL=navigation.js.map