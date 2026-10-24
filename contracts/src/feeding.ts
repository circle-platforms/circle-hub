// Model-owned schemas for the layer beside seedlings. Shape validation is not source or binding admission.
import {FeedingQuoteSchema,FedCaseSchema,FedDefectSchema,FedSpecSchema,FedBuildSchema,FedNoteSchema,VersionBindingSchema,FeedingUsageSchema,FeedingOffsetSchema,FeedingRetractionSchema,KnowledgeStructureSchema} from '../generated/shared-interfaces.ts';
export {FeedingQuoteSchema,FedCaseSchema,FedDefectSchema,FedSpecSchema,FedBuildSchema,FedNoteSchema,VersionBindingSchema,FeedingUsageSchema,FeedingOffsetSchema,FeedingRetractionSchema,KnowledgeStructureSchema};
export type {FeedingQuote,FedCase,FedDefect,FedSpec,FedBuild,FedNote,VersionBinding,FeedingUsage,FeedingOffset,FeedingRetraction,KnowledgeStructure} from '../generated/shared-interfaces.ts';
export const FEEDING_SCHEMAS={
 'feeding-quote@1':FeedingQuoteSchema,
 'fed-case@1':FedCaseSchema,'fed-defect@1':FedDefectSchema,'fed-spec@1':FedSpecSchema,'fed-build@1':FedBuildSchema,'fed-note@1':FedNoteSchema,
 'version-binding@1':VersionBindingSchema,'usage@1':FeedingUsageSchema,'feeding-offset@1':FeedingOffsetSchema,'retraction@1':FeedingRetractionSchema,'knowledge-structure@1':KnowledgeStructureSchema,
};
