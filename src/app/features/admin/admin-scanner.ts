import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import {DatePipe, isPlatformBrowser} from '@angular/common';
import {FormBuilder, ReactiveFormsModule, Validators} from '@angular/forms';
import {MatIconModule} from '@angular/material/icon';
import {BrowserQRCodeReader, IScannerControls} from '@zxing/browser';
import jsQR from 'jsqr';
import {firstValueFrom} from 'rxjs';
import {ApiService} from '../../core/services/api.service';
import {ToastService} from '../../core/services/toast.service';
import {QRVerificationResult} from '../../core/models/types';
import {StatusText} from '../../shared/components/status-text';

@Component({
  selector: 'app-admin-scanner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, ReactiveFormsModule, MatIconModule, StatusText],
  template: `
    <div class="space-y-6">
      <div>
        <h1 class="fluid-page-title font-bold text-[#0F172A] font-display">Admin QR Verification Scanner</h1>
        <p class="mt-1 text-sm text-slate-600">
          Scan live credentials with mobile or desktop cameras, decode an uploaded QR image, or verify a token payload.
        </p>
      </div>

      <div class="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
        <!-- Scanner Viewport Column -->
        <section class="lg:col-span-6 rounded-xl border border-slate-200 bg-white p-5 space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h2 class="text-sm font-bold text-[#0F172A] font-display">Camera &amp; Image Input</h2>
            <div class="flex items-center gap-2">
              @if (!cameraActive()) {
                <button
                  type="button"
                  (click)="startCamera()"
                  class="touch-target inline-flex items-center gap-1.5 rounded-lg bg-[#0F172A] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#1E3A5F] whitespace-nowrap"
                >
                  <mat-icon class="text-[18px]!">videocam</mat-icon>
                  <span>Start Camera</span>
                </button>
              } @else {
                <button
                  type="button"
                  (click)="stopCamera()"
                  class="touch-target inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 whitespace-nowrap"
                >
                  <mat-icon class="text-[18px]!">videocam_off</mat-icon>
                  <span>Stop Camera</span>
                </button>
              }
            </div>
          </div>

          @if (cameras().length > 0) {
            <div>
              <label for="cam-select" class="block text-xs font-semibold text-slate-700 mb-1">Select Camera</label>
              <select
                id="cam-select"
                [value]="selectedDeviceId()"
                (change)="onCameraChange($event)"
                class="w-full h-10 rounded-lg border border-slate-300 bg-white px-3 text-xs"
              >
                @for (cam of cameras(); track cam.deviceId) {
                  <option [value]="cam.deviceId">{{ cam.label || 'Camera ' + ($index + 1) }}</option>
                }
              </select>
            </div>
          }

          <div class="relative aspect-[4/3] w-full overflow-hidden rounded-xl border border-slate-200 bg-[#0F172A] flex items-center justify-center">
            <video
              #videoEl
              class="h-full w-full object-cover"
              [class.hidden]="!cameraActive()"
              muted
              playsinline
            ></video>
            @if (!cameraActive()) {
              <div class="text-center px-6 text-slate-300 space-y-2">
                <mat-icon class="text-[42px]! text-slate-400">qr_code_scanner</mat-icon>
                <p class="text-xs">
                  {{ cameraError() || 'Click Start Camera to scan with your device camera, or upload/paste a QR below.' }}
                </p>
              </div>
            }
          </div>

          <!-- Upload QR Image & Manual Paste -->
          <div class="space-y-3 border-t border-slate-200 pt-4">
            <div>
              <label for="qr-file-upload" class="block text-xs font-semibold text-slate-700 mb-1.5">
                Decode QR Image File (PNG/JPG)
              </label>
              <input
                id="qr-file-upload"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                (change)="decodeQrFile($event)"
                class="block w-full text-xs text-slate-600 file:mr-3 file:rounded-lg file:border file:border-slate-300 file:bg-slate-50 file:px-3 file:py-2 file:text-xs file:font-semibold"
              />
            </div>

            <form [formGroup]="manualForm" (ngSubmit)="verifyManual()" class="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                formControlName="payload"
                placeholder="Paste verification URL or opaque token..."
                aria-label="Manual verification payload"
                class="flex-1 h-10 rounded-lg border border-slate-300 px-3 font-mono text-xs"
              />
              <button
                type="submit"
                [disabled]="verifying()"
                class="touch-target inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#1E3A5F] px-4 py-2 text-xs font-semibold text-white hover:bg-[#0F172A] whitespace-nowrap"
              >
                <mat-icon class="text-[18px]!">verified_user</mat-icon>
                <span>Verify Token</span>
              </button>
            </form>
          </div>
        </section>

        <!-- Verification Result Column -->
        <section class="lg:col-span-6 space-y-4">
          @if (result(); as res) {
            <div
              class="rounded-xl border bg-white p-5 sm:p-6 space-y-4"
              [class.border-emerald-300]="res.resultStatus === 'VALID'"
              [class.border-amber-300]="res.resultStatus === 'EXPIRED'"
              [class.border-red-300]="res.resultStatus !== 'VALID' && res.resultStatus !== 'EXPIRED'"
            >
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span
                  class="text-lg font-extrabold font-display tracking-tight"
                  [class.text-emerald-700]="res.resultStatus === 'VALID'"
                  [class.text-amber-700]="res.resultStatus === 'EXPIRED'"
                  [class.text-red-700]="res.resultStatus !== 'VALID' && res.resultStatus !== 'EXPIRED'"
                >
                  {{ res.label }}
                </span>
                <app-status-text [status]="res.resultStatus" />
              </div>

              <p class="text-sm text-slate-700">{{ res.reason }}</p>

              @if (res.duplicatePrevented) {
                <p class="text-xs font-medium text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
                  Duplicate scan detected within 10 seconds — scan count was not double-incremented.
                </p>
              }

              @if (res.holder; as h) {
                <div class="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs font-medium text-slate-800">
                  {{ res.identityComparisonNotice }}
                </div>

                <div class="flex flex-col gap-4 sm:flex-row sm:items-start border-t border-slate-200 pt-4">
                  <img
                    [src]="h.profilePhotoUrl"
                    [alt]="h.fullName"
                    class="h-28 w-28 shrink-0 rounded-xl border border-slate-200 object-cover bg-white"
                    referrerpolicy="no-referrer"
                  />
                  <div class="min-w-0 flex-1 space-y-1.5 text-xs">
                    <p class="text-base font-bold text-[#0F172A] font-display">{{ h.fullName }}</p>
                    <p class="font-mono font-semibold text-slate-700 tabular-nums">{{ h.registrationId }}</p>
                    <p class="text-slate-600">{{ h.email }} · {{ h.mobile }}</p>
                    <p class="text-slate-600">{{ h.city }}, {{ h.state }}, {{ h.country }}</p>
                    <p class="text-slate-600">ID Document: {{ h.idProofType }}</p>
                  </div>
                </div>
              }
            </div>
          } @else {
            <div class="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
              Scan a QR credential or paste a verification URL to inspect cryptographic status and holder photograph.
            </div>
          }

          <!-- Scan Logs -->
          <div class="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div class="border-b border-slate-200 px-5 py-3.5">
              <h3 class="text-sm font-bold text-[#0F172A] font-display">Recent Verification Logs</h3>
            </div>
            <div class="divide-y divide-slate-100 max-h-72 overflow-y-auto">
              @for (log of scanLogs(); track log['id']) {
                <div class="flex items-center justify-between gap-3 px-5 py-2.5 text-xs">
                  <div class="min-w-0">
                    <p class="truncate font-semibold text-slate-900">
                      {{ log['holder_name'] || 'Unknown Token' }}
                    </p>
                    <p class="font-mono text-[11px] text-slate-500 tabular-nums">
                      {{ log['scanned_token_prefix'] }} · {{ '' + log['scanned_at'] | date: 'short' }}
                    </p>
                  </div>
                  <app-status-text [status]="'' + log['result_status']" />
                </div>
              }
            </div>
          </div>
        </section>
      </div>
    </div>
  `,
})
export class AdminScanner implements OnInit, OnDestroy {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly platformId = inject(PLATFORM_ID);

  @ViewChild('videoEl') private videoRef?: ElementRef<HTMLVideoElement>;

  private codeReader: BrowserQRCodeReader | null = null;
  private controls: IScannerControls | null = null;
  private lastDecodedPayload = '';
  private lastDecodedAt = 0;

  protected readonly cameras = signal<MediaDeviceInfo[]>([]);
  protected readonly selectedDeviceId = signal<string>('');
  protected readonly cameraActive = signal(false);
  protected readonly cameraError = signal<string | null>(null);
  protected readonly verifying = signal(false);
  protected readonly result = signal<QRVerificationResult | null>(null);
  protected readonly scanLogs = signal<Record<string, unknown>[]>([]);

  protected readonly manualForm = this.fb.group({
    payload: ['', Validators.required],
  });

  ngOnInit(): void {
    void this.loadScanLogs();
  }

  ngOnDestroy(): void {
    this.stopCamera();
  }

  async loadScanLogs(): Promise<void> {
    try {
      const res = await firstValueFrom(this.api.getAdminScanLogs());
      this.scanLogs.set(res.logs);
    } catch {
      this.toast.error('Log Error', 'Unable to load recent verification logs.');
    }
  }

  async startCamera(): Promise<void> {
    if (!isPlatformBrowser(this.platformId)) return;
    this.cameraError.set(null);
    try {
      const devices = await BrowserQRCodeReader.listVideoInputDevices();
      this.cameras.set(devices);
      const preferred =
        this.selectedDeviceId() ||
        devices.find((d) => d.label.toLowerCase().includes('back'))?.deviceId ||
        devices[0]?.deviceId ||
        '';
      this.selectedDeviceId.set(preferred);

      this.codeReader = new BrowserQRCodeReader();
      this.cameraActive.set(true);

      setTimeout(async () => {
        if (!this.videoRef?.nativeElement || !this.codeReader) return;
        try {
          this.controls = await this.codeReader.decodeFromVideoDevice(
            preferred || undefined,
            this.videoRef.nativeElement,
            (res) => {
              if (res) {
                const text = res.getText();
                const now = Date.now();
                if (text !== this.lastDecodedPayload || now - this.lastDecodedAt > 3500) {
                  this.lastDecodedPayload = text;
                  this.lastDecodedAt = now;
                  void this.verifyPayload(text);
                }
              }
            },
          );
        } catch (err) {
          this.cameraActive.set(false);
          this.cameraError.set(
            err instanceof Error
              ? err.message
              : 'Camera permission denied or no camera device detected.',
          );
        }
      }, 50);
    } catch {
      this.cameraError.set('Unable to access camera devices. Check browser camera permissions.');
    }
  }

  stopCamera(): void {
    if (this.controls) {
      this.controls.stop();
      this.controls = null;
    }
    this.cameraActive.set(false);
  }

  onCameraChange(event: Event): void {
    const id = (event.target as HTMLSelectElement).value;
    this.selectedDeviceId.set(id);
    if (this.cameraActive()) {
      this.stopCamera();
      void this.startCamera();
    }
  }

  decodeQrFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        input.value = '';
        return;
      }
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const decoded = jsQR(imageData.data, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      input.value = '';
      if (decoded?.data) {
        void this.verifyPayload(decoded.data);
      } else {
        this.toast.error('Decode Failed', 'No valid QR matrix detected in the uploaded image.');
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      input.value = '';
      this.toast.error('Invalid Image', 'Could not read the selected image file.');
    };
    img.src = url;
  }

  async verifyManual(): Promise<void> {
    const payload = String(this.manualForm.value.payload || '').trim();
    if (!payload) return;
    await this.verifyPayload(payload);
  }

  async verifyPayload(payload: string): Promise<void> {
    this.verifying.set(true);
    try {
      const res = await firstValueFrom(this.api.verifyQrPayload(payload));
      this.result.set(res);
      await this.loadScanLogs();
      if (res.resultStatus === 'VALID') {
        this.toast.success('VALID QR', `Verified holder: ${res.holder?.fullName}`);
      } else {
        this.toast.warning(res.label, res.reason);
      }
    } catch {
      this.toast.error('Verification Error', 'Unable to verify QR payload.');
    } finally {
      this.verifying.set(false);
    }
  }
}
