/**
 * Edit and remove a single meetup.
 *
 * DELETE cancels by default — the meetup stays in the public feed carrying
 * STATUS:CANCELLED, which is how a subscriber who already has it on their
 * phone learns it is off. `?hard=1` really deletes, and is reserved for admins,
 * exactly as on POIs (admin audit, 2026-10).
 */

import type { APIContext } from 'astro';
import { env } from 'cloudflare:workers';
import {
  ApiError,
  handler,
  intParam,
  json,
  noContent,
  readJson,
  requireRole,
  requireRowExists,
} from '~/lib/api';
import { auditStatement, diffFields } from '~/lib/db/audit';
import { settleAnnouncement } from '~/lib/notify/announcements';
import { meetupFields, toUtcOrThrow } from './index';

export const prerender = false;

const patchInput = meetupFields.partial();

interface MeetupRecord {
  id: number;
  slug: string;
  title: string;
  description_md: string | null;
  starts_at: string;
  ends_at: string | null;
  tz: string;
  poi_id: number | null;
  location_text: string | null;
  campfire_url: string | null;
  recurrence_rule: string | null;
  status: string;
  announce_requested: number;
}

async function loadMeetup(id: number): Promise<MeetupRecord> {
  const row = await env.DB.prepare('SELECT * FROM meetups WHERE id = ?1')
    .bind(id)
    .first<MeetupRecord>();
  if (!row) throw new ApiError(404, 'Meetup not found');
  return row;
}

export const PATCH = handler(async (ctx: APIContext) => {
  const user = requireRole(ctx, 'ambassador');
  const id = intParam(ctx, 'id');
  const input = await readJson(ctx, patchInput);
  const before = await loadMeetup(id);

  const tz = input.tz ?? before.tz;
  let startsAt = before.starts_at;
  let endsAt = before.ends_at;

  if (input.startsAtLocal) startsAt = toUtcOrThrow(input.startsAtLocal, tz);
  if (input.endsAtLocal !== undefined) {
    endsAt = input.endsAtLocal ? toUtcOrThrow(input.endsAtLocal, tz) : null;
  }

  if (endsAt && endsAt <= startsAt) throw new ApiError(422, 'End time must be after the start time');

  await requireRowExists(env.DB, 'pois', input.poiId, 'poiId');

  const next = {
    title: input.title ?? before.title,
    description_md: input.descriptionMd === undefined ? before.description_md : input.descriptionMd,
    starts_at: startsAt,
    ends_at: endsAt,
    tz,
    poi_id: input.poiId === undefined ? before.poi_id : input.poiId,
    location_text: input.locationText === undefined ? before.location_text : input.locationText,
    campfire_url:
      input.campfireUrl === undefined ? before.campfire_url : input.campfireUrl || null,
    recurrence_rule:
      input.recurrenceRule === undefined ? before.recurrence_rule : input.recurrenceRule || null,
    status: input.status ?? before.status,
    announce_requested: (
      input.announce === undefined ? before.announce_requested === 1 : input.announce
    )
      ? 1
      : 0,
  };

  const diff = diffFields(before as unknown as Record<string, unknown>, next);

  // The change and its audit row commit together, or neither does (admin
  // audit, 2026-10, B-15).
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE meetups SET title = ?2, description_md = ?3, starts_at = ?4, ends_at = ?5, tz = ?6,
                          poi_id = ?7, location_text = ?8, campfire_url = ?9, recurrence_rule = ?10,
                          status = ?11, announce_requested = ?12,
                          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?1`,
    ).bind(
      id,
      next.title,
      next.description_md,
      next.starts_at,
      next.ends_at,
      next.tz,
      next.poi_id,
      next.location_text,
      next.campfire_url,
      next.recurrence_rule,
      next.status,
      next.announce_requested,
    ),
    ...(diff
      ? [
          auditStatement(env.DB, {
            actorId: user.id,
            action: 'update',
            entity: 'meetup',
            entityId: id,
            diff,
          }),
        ]
      : []),
  ]);

  // Every save, not only the ones carrying `announce`: a draft that was created
  // with the box ticked becomes announceable the moment it is published here.
  const announced = await settleAnnouncement(ctx, env, 'meetups', id, next.announce_requested === 1);

  return json({ id, changed: diff !== null, startsAt: next.starts_at, announced });
});

export const DELETE = handler(async (ctx: APIContext) => {
  const user = requireRole(ctx, 'ambassador');
  const id = intParam(ctx, 'id');
  const hard = new URL(ctx.request.url).searchParams.get('hard') === '1';
  // Before the lookup, so an ambassador learns nothing about which ids exist.
  if (hard) requireRole(ctx, 'admin');
  const before = await loadMeetup(id);

  const change = hard
    ? env.DB.prepare('DELETE FROM meetups WHERE id = ?1').bind(id)
    : env.DB.prepare(
        `UPDATE meetups SET status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          WHERE id = ?1`,
      ).bind(id);

  await env.DB.batch([
    change,
    auditStatement(env.DB, {
      actorId: user.id,
      action: hard ? 'delete' : 'archive',
      entity: 'meetup',
      entityId: id,
      diff: { title: before.title, startsAt: before.starts_at, status: before.status },
    }),
  ]);

  return noContent();
});
