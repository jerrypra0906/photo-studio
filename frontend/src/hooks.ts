import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface BookingType { id: string; name: string; hourlyRate: number; requiresPhotographer: boolean; minHours: number; maxHours: number; calendarKeyword: string; colorId: string | null; active: boolean; sortOrder: number; inUse: boolean }
export interface Photographer { id: string; name: string; phone: string | null; email: string | null; defaultFee: number | null; feeUnit: 'SESSION' | 'HOUR'; active: boolean; inUse: boolean }
export interface Addon { id: string; name: string; price: number; unit: 'HOUR' | 'BOOKING' | 'PERSON'; typeIds: string[]; vendorFee: number | null; vendorName: string | null; active: boolean; sortOrder: number; inUse: boolean }
export interface Category { id: string; code: string | null; name: string; kind: 'FIXED' | 'VARIABLE'; recurring: boolean; defaultAmount: number | null; active: boolean; sortOrder: number; inUse: boolean; recentUses: number }
export interface DayHours { open: string; close: string; closed: boolean }
export interface Settings {
  studioName: string; studioPhone: string; address: string; mapsUrl: string; bankName: string; accountNo: string; accountHolder: string;
  openHours: DayHours[]; slotStepMin: 30 | 60; maxHours: number; bufferMin: number; dpRuleText: string; termsText: string;
  revenueBasis: 'BILLED' | 'COLLECTED'; gcalStatus: 'NOT_CONNECTED' | 'CONNECTED' | 'RECONNECT_NEEDED'; gcalAccountEmail: string | null;
  gcalCalendarId: string | null; gcalCalendarName: string | null; gcalCancelMode: 'DELETE' | 'MARK'; gcalMarkCompleted: boolean;
}

export const useTypes = () => useQuery({ queryKey: ['booking-types'], queryFn: () => api.get<BookingType[]>('/booking-types') });
export const usePhotographers = () => useQuery({ queryKey: ['photographers'], queryFn: () => api.get<Photographer[]>('/photographers') });
export const useAddons = () => useQuery({ queryKey: ['addons'], queryFn: () => api.get<Addon[]>('/addons') });
export const useCategories = () => useQuery({ queryKey: ['expense-categories'], queryFn: () => api.get<Category[]>('/expense-categories') });
export const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/settings') });

export const UNIT_LABEL: Record<string, string> = { HOUR: '/ jam', BOOKING: '/ booking', PERSON: '/ orang' };
export const CANCEL_REASONS: [string, string][] = [
  ['CUSTOMER_CANCELLED', 'Klien membatalkan'], ['NO_SHOW', 'Klien tidak datang'], ['STUDIO_CANCELLED', 'Studio membatalkan'], ['OTHER', 'Lainnya'],
];
