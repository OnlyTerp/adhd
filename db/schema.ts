import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';
export const sessions=sqliteTable('sessions',{
 id:text('id').primaryKey(),owner:text('owner').notNull(),goal:text('goal').notNull(),
 revision:integer('revision').notNull().default(0),document:text('document').notNull().default(''),
 eventCount:integer('event_count').notNull().default(0),payloadBytes:integer('payload_bytes').notNull().default(0),
 createRequestId:text('create_request_id'),state:text('state').notNull().default('ready'),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull()
},t=>[uniqueIndex('sessions_owner_create_request').on(t.owner,t.createRequestId).where(sql`${t.createRequestId} IS NOT NULL`)]);
export const events=sqliteTable('events',{
 sessionId:text('session_id').notNull().references(()=>sessions.id),id:text('id').notNull(),sequence:integer('sequence').notNull(),
 role:text('role').notNull(),type:text('type').notNull(),createdAt:text('created_at').notNull(),
 data:text('data').notNull(),payload:text('payload').notNull(),payloadBytes:integer('payload_bytes').notNull(),
 document:text('document'),expectedRevision:integer('expected_revision')
},t=>[primaryKey({columns:[t.sessionId,t.id]}),uniqueIndex('events_sequence').on(t.sessionId,t.sequence)]);
export const revisions=sqliteTable('document_revisions',{
 sessionId:text('session_id').notNull().references(()=>sessions.id),revision:integer('revision').notNull(),
 eventId:text('event_id').notNull(),markdown:text('markdown').notNull(),createdAt:text('created_at').notNull()
},t=>[primaryKey({columns:[t.sessionId,t.revision]})]);
export const launchRequests=sqliteTable('launch_requests',{
 sessionId:text('session_id').primaryKey().references(()=>sessions.id,{onDelete:'cascade'}),requestId:text('request_id').notNull(),configuration:text('configuration').notNull(),
 state:text('state').notNull().default('prepared'),deliveryState:text('delivery_state').notNull().default('pending'),dispatchId:text('dispatch_id'),claimId:text('claim_id'),receipt:text('receipt'),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull()
});
