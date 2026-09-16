module.exports = {
    DEFAULT_URL: 'https://apistaging.healthforcehub.link/api/ExternalMFACodes/UpdateExternalMFACode',
    DEFAULT_API_KEY: 'CCM-MAKE-INTEGRATION-2024',
    MFA_TYPE_TOTP: 0,
    MFA_TYPE_SMS: 1,
    DEFAULT_TARGETS: [
        {
            source: 'fortitoken',
            account: 'tmalik',
            aliases: ['tmalik', 'CC - tmalik', 'CC-tmalik'],
            title: 'CC - tmalik',
            automationShortCode: 'CC',
        },
        {
            source: 'fortitoken',
            account: 'jjilani',
            aliases: ['jjilani', 'CM - jjilani', 'CM-jjilani'],
            title: 'CM - jjilani',
            automationShortCode: 'CM',
        },
        {
            source: 'fortitoken',
            account: 'mmehmood',
            aliases: ['mahmood', 'mmehmood', 'CIS - mmehmood', 'CIS-mmehmood', 'CIS-mahmood'],
            title: 'CIS - mmehmood',
            automationShortCode: 'CIS',
        },
    ],
};
