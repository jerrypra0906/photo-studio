import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { BookingInput, TEMPLATE_KINDS, TemplateKind, bookingInput, cancelInput, completeInput, paymentInput } from '@jes/shared';
import { AuthUser, Body$, CurrentUser, badRequest } from '../common/http';
import { BookingsService } from './bookings.service';
import { DocumentsService } from './documents.service';

const Id = new ParseUUIDPipe();
const ymd = /^\d{4}-\d{2}-\d{2}$/;

@Controller()
export class BookingsController {
  constructor(private svc: BookingsService, private docs: DocumentsService) {}

  @Get('bookings')
  list(
    @Query('q') q?: string, @Query('status') status?: string, @Query('from') from?: string, @Query('to') to?: string,
    @Query('typeId') typeId?: string, @Query('includeCancelled') includeCancelled?: string, @Query('toClose') toClose?: string,
  ) {
    if ((from && !ymd.test(from)) || (to && !ymd.test(to))) throw badRequest('Tanggal tidak valid');
    if (status && !['CONFIRMED', 'COMPLETED', 'CANCELLED'].includes(status)) throw badRequest('Status tidak valid');
    if (typeId && !z.string().uuid().safeParse(typeId).success) throw badRequest('Jenis tidak valid');
    return this.svc.list({ q, status, from, to, typeId, includeCancelled: includeCancelled === 'true', toClose: toClose === 'true' });
  }

  @Get('schedule')
  schedule(@Query('from') from: string, @Query('to') to: string, @Query('excludeId') excludeId?: string) {
    if (!ymd.test(from ?? '') || !ymd.test(to ?? '')) throw badRequest('Tanggal tidak valid');
    if (excludeId && !z.string().uuid().safeParse(excludeId).success) throw badRequest('ID tidak valid');
    return this.svc.schedule(from, to, excludeId);
  }

  @Get('clients')
  clients(@Query('q') q = '') {
    return this.svc.clients(q.slice(0, 60));
  }

  @Get('bookings/:id')
  get(@Param('id', Id) id: string, @CurrentUser() u: AuthUser) {
    return this.svc.get(id, u);
  }

  /** TD flow 4.1: Idempotency-Key makes a retried save return the same booking (US-11.3). */
  @Post('bookings')
  create(@Body(Body$(bookingInput)) b: BookingInput, @CurrentUser() u: AuthUser, @Headers('idempotency-key') key?: string) {
    return this.svc.create(b, u, key?.slice(0, 100));
  }

  /** TD flow 4.2: If-Match carries the version the form was loaded with. */
  @Patch('bookings/:id')
  update(@Param('id', Id) id: string, @Body(Body$(bookingInput)) b: BookingInput, @CurrentUser() u: AuthUser, @Headers('if-match') ifMatch?: string) {
    const v = ifMatch ? Number(ifMatch.replace(/\D/g, '')) : undefined;
    return this.svc.update(id, b, u, Number.isFinite(v) ? v : undefined);
  }

  @Post('bookings/:id/cancel') @HttpCode(200)
  cancel(@Param('id', Id) id: string, @Body(Body$(cancelInput)) b: z.infer<typeof cancelInput>, @CurrentUser() u: AuthUser) {
    return this.svc.cancel(id, b.reason, b.note, u);
  }

  @Post('bookings/:id/complete') @HttpCode(200)
  complete(@Param('id', Id) id: string, @Body(Body$(completeInput)) b: { paidAmount: number }, @CurrentUser() u: AuthUser) {
    return this.svc.complete(id, b.paidAmount, u);
  }

  @Post('bookings/:id/payment') @HttpCode(200)
  payment(@Param('id', Id) id: string, @Body(Body$(paymentInput)) b: { paidAmount: number }, @CurrentUser() u: AuthUser) {
    return this.svc.payment(id, b.paidAmount, u);
  }

  @Post('bookings/:id/invoice-sent') @HttpCode(200)
  sent(@Param('id', Id) id: string, @CurrentUser() u: AuthUser) {
    return this.svc.markInvoiceSent(id, true, u);
  }

  @Delete('bookings/:id/invoice-sent')
  unsent(@Param('id', Id) id: string, @CurrentUser() u: AuthUser) {
    return this.svc.markInvoiceSent(id, false, u);
  }

  @Post('bookings/:id/sync') @HttpCode(200)
  sync(@Param('id', Id) id: string, @CurrentUser() u: AuthUser) {
    return this.svc.retrySync(id, u);
  }

  @Get('bookings/:id/message')
  message(@Param('id', Id) id: string, @Query('kind') kind = 'NEW') {
    if (!(TEMPLATE_KINDS as readonly string[]).includes(kind)) throw badRequest('Jenis template tidak valid');
    return this.docs.message(id, kind as TemplateKind);
  }

  @Get('bookings/:id/invoice.pdf')
  async invoice(@Param('id', Id) id: string, @Res() res: Response) {
    const { pdf, filename } = await this.docs.invoice(id);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${filename}"`, 'Cache-Control': 'no-store' });
    res.send(pdf);
  }
}
