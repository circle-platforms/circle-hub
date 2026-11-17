import {runById,canViewRun,readPackDirectory,packSchema} from '../../runs/api.ts';
import type {KnowledgeRunReadPort,KnowledgePackReadPort} from '../../ports.ts';

export const TEST_KNOWLEDGE_READ_PORTS: {runReads:KnowledgeRunReadPort;packReads:KnowledgePackReadPort} = {
 runReads:{runById,canViewRun},
 packReads:{readPackDirectory,packSchema},
};
