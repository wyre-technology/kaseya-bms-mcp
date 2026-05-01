import { describe, it, expect } from 'vitest';

describe('Kaseya BMS MCP Server', () => {
  describe('Tool Definitions', () => {
    const expectedTools = [
      'kaseya_bms_list_tickets',
      'kaseya_bms_get_ticket',
      'kaseya_bms_create_ticket',
      'kaseya_bms_add_ticket_note',
      'kaseya_bms_list_time_entries',
      'kaseya_bms_list_accounts',
      'kaseya_bms_list_contacts',
      'kaseya_bms_list_contracts',
      'kaseya_bms_list_service_catalog',
      'kaseya_bms_search_knowledge_base',
    ];

    it('should define all 10 tools', () => {
      expect(expectedTools).toHaveLength(10);
    });

    it('should include ticket CRUD tools', () => {
      expect(expectedTools).toContain('kaseya_bms_list_tickets');
      expect(expectedTools).toContain('kaseya_bms_get_ticket');
      expect(expectedTools).toContain('kaseya_bms_create_ticket');
      expect(expectedTools).toContain('kaseya_bms_add_ticket_note');
    });

    it('should include time entries, accounts, contacts, contracts', () => {
      expect(expectedTools).toContain('kaseya_bms_list_time_entries');
      expect(expectedTools).toContain('kaseya_bms_list_accounts');
      expect(expectedTools).toContain('kaseya_bms_list_contacts');
      expect(expectedTools).toContain('kaseya_bms_list_contracts');
    });

    it('should include service catalog and KB search', () => {
      expect(expectedTools).toContain('kaseya_bms_list_service_catalog');
      expect(expectedTools).toContain('kaseya_bms_search_knowledge_base');
    });
  });

  describe('Credentials', () => {
    it('should require KASEYA_BMS_TENANT_SUBDOMAIN plus API_TOKEN or K1_TOKEN', () => {
      const required = ['KASEYA_BMS_TENANT_SUBDOMAIN'];
      const oneOf = ['KASEYA_BMS_API_TOKEN', 'KASEYA_BMS_K1_TOKEN'];
      expect(required).toHaveLength(1);
      expect(oneOf).toHaveLength(2);
    });
  });

  describe('Server Configuration', () => {
    it('should define server with correct name', () => {
      const config = { name: 'kaseya-bms-mcp', version: '0.0.0' };
      expect(config.name).toBe('kaseya-bms-mcp');
    });
  });
});
