import {ChangeDetectionStrategy, Component, OnInit, inject, signal} from '@angular/core';
import {FormBuilder, ReactiveFormsModule, Validators} from '@angular/forms';
import {MatIconModule} from '@angular/material/icon';
import {firstValueFrom} from 'rxjs';
import {ApiService} from '../../core/services/api.service';
import {AuthService} from '../../core/services/auth.service';
import {ToastService} from '../../core/services/toast.service';
import {DynamicFieldConfig, UserRecord} from '../../core/models/types';
import {StatusText} from '../../shared/components/status-text';

@Component({
  selector: 'app-user-profile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatIconModule, StatusText],
  template: `
    <div class="space-y-6">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 class="fluid-page-title font-bold text-[#0F172A] font-display">My Profile &amp; Registration</h1>
          <p class="mt-1 text-sm text-slate-600">
            Inspect your registered details, uploaded documents, or submit corrections if requested.
          </p>
        </div>
        @if (record(); as rec) {
          <app-status-text [status]="rec.approval_status" />
        }
      </div>

      @if (record(); as rec) {
        @if (rec.approval_status === 'RESUBMISSION_REQUIRED') {
          <div class="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
            <p class="font-bold">Resubmission Instructions from Admin:</p>
            <p class="mt-1">{{ rec.resubmission_note }}</p>
          </div>
        }

        <form [formGroup]="form" (ngSubmit)="saveOrResubmit()" class="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 space-y-6">
          <div class="flex flex-col gap-4 sm:flex-row sm:items-center border-b border-slate-200 pb-5">
            <img
              [src]="photoPreview() || rec.profile_photo_url"
              [alt]="rec.full_name"
              class="h-20 w-20 rounded-xl border border-slate-200 object-cover"
              referrerpolicy="no-referrer"
            />
            <div class="space-y-1">
              <p class="text-sm font-bold text-slate-900">{{ rec.full_name }}</p>
              <p class="font-mono text-xs text-slate-500 tabular-nums">
                {{ rec.registration_id }} · {{ rec.email }} · {{ rec.mobile }}
              </p>
              <label class="inline-flex items-center gap-1.5 text-xs font-semibold text-[#1E3A5F] cursor-pointer hover:underline">
                <mat-icon class="text-[16px]!">photo_camera</mat-icon>
                <span>Update Photo</span>
                <input type="file" accept="image/png,image/jpeg,image/webp" (change)="onFile($event, 'photo')" class="sr-only" />
              </label>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label for="prof-name" class="block text-xs font-semibold text-slate-700 mb-1.5">Full Name</label>
              <input id="prof-name" type="text" formControlName="fullName" class="w-full h-11 rounded-lg border border-slate-300 px-3.5 text-sm" />
            </div>
            <div>
              <label for="prof-dob" class="block text-xs font-semibold text-slate-700 mb-1.5">Date of Birth</label>
              <input id="prof-dob" type="date" formControlName="dob" class="w-full h-11 rounded-lg border border-slate-300 px-3.5 text-sm" />
            </div>
            <div class="sm:col-span-2">
              <label for="prof-addr" class="block text-xs font-semibold text-slate-700 mb-1.5">Address</label>
              <input id="prof-addr" type="text" formControlName="address" class="w-full h-11 rounded-lg border border-slate-300 px-3.5 text-sm" />
            </div>
            <div>
              <label for="prof-city" class="block text-xs font-semibold text-slate-700 mb-1.5">City</label>
              <input id="prof-city" type="text" formControlName="city" class="w-full h-11 rounded-lg border border-slate-300 px-3.5 text-sm" />
            </div>
            <div>
              <label for="prof-district" class="block text-xs font-semibold text-slate-700 mb-1.5">District</label>
              <input id="prof-district" type="text" formControlName="district" class="w-full h-11 rounded-lg border border-slate-300 px-3.5 text-sm" />
            </div>
            <div>
              <label for="prof-state" class="block text-xs font-semibold text-slate-700 mb-1.5">State</label>
              <input id="prof-state" type="text" formControlName="state" class="w-full h-11 rounded-lg border border-slate-300 px-3.5 text-sm" />
            </div>
            <div>
              <label for="prof-country" class="block text-xs font-semibold text-slate-700 mb-1.5">Country</label>
              <input id="prof-country" type="text" formControlName="country" class="w-full h-11 rounded-lg border border-slate-300 px-3.5 text-sm" />
            </div>
            <div>
              <label for="prof-postal" class="block text-xs font-semibold text-slate-700 mb-1.5">Postal Code</label>
              <input id="prof-postal" type="text" formControlName="postalCode" class="w-full h-11 rounded-lg border border-slate-300 font-mono text-sm" />
            </div>
            <div>
              <label for="prof-idproof" class="block text-xs font-semibold text-slate-700 mb-1.5">Replace ID Proof Document</label>
              <input id="prof-idproof" type="file" accept="image/png,image/jpeg,image/webp,application/pdf" (change)="onFile($event, 'idproof')" class="block w-full text-xs text-slate-600 file:mr-3 file:rounded-lg file:border file:border-slate-300 file:bg-slate-50 file:px-3 file:py-2 file:text-xs file:font-semibold" />
            </div>
          </div>

          @if (dynamicFields().length > 0) {
            <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 border-t border-slate-200 pt-5" formGroupName="dynamicFields">
              @for (f of dynamicFields(); track f.id) {
                <div>
                  <label [for]="'p-dyn-' + f.fieldKey" class="block text-xs font-semibold text-slate-700 mb-1.5">{{ f.label }}</label>
                  @if (f.fieldType === 'select') {
                    <select [id]="'p-dyn-' + f.fieldKey" [formControlName]="f.fieldKey" class="w-full h-11 rounded-lg border border-slate-300 bg-white px-3.5 text-sm">
                      @for (opt of f.options; track opt) {
                        <option [value]="opt">{{ opt }}</option>
                      }
                    </select>
                  } @else {
                    <input [id]="'p-dyn-' + f.fieldKey" type="text" [formControlName]="f.fieldKey" class="w-full h-11 rounded-lg border border-slate-300 px-3.5 text-sm" />
                  }
                </div>
              }
            </div>
          }

          @if (rec.approval_status === 'RESUBMISSION_REQUIRED') {
            <div>
              <label for="resubmit-note" class="block text-xs font-semibold text-slate-700 mb-1.5">
                Resubmission Note to Administrator
              </label>
              <textarea
                id="resubmit-note"
                rows="2"
                formControlName="resubmissionComment"
                placeholder="Describe the corrections made..."
                class="w-full rounded-lg border border-slate-300 p-3 text-sm"
              ></textarea>
            </div>
          }

          <div class="flex justify-end">
            <button
              type="submit"
              [disabled]="saving()"
              class="touch-target inline-flex items-center gap-2 rounded-lg bg-[#0F172A] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#1E3A5F] disabled:opacity-50"
            >
              <mat-icon class="text-[18px]!">{{ rec.approval_status === 'RESUBMISSION_REQUIRED' ? 'send' : 'save' }}</mat-icon>
              <span>
                {{
                  saving()
                    ? 'Saving...'
                    : rec.approval_status === 'RESUBMISSION_REQUIRED'
                      ? 'Save & Resubmit for Approval'
                      : 'Save Profile Changes'
                }}
              </span>
            </button>
          </div>
        </form>
      }
    </div>
  `,
})
export class UserProfile implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  protected readonly record = signal<UserRecord | null>(null);
  protected readonly dynamicFields = signal<DynamicFieldConfig[]>([]);
  protected readonly saving = signal(false);
  protected readonly photoPreview = signal<string | null>(null);
  protected readonly photoData = signal<string | null>(null);
  protected readonly idProofData = signal<string | null>(null);

  protected readonly form = this.fb.group({
    fullName: ['', Validators.required],
    dob: [''],
    address: ['', Validators.required],
    city: ['', Validators.required],
    district: ['', Validators.required],
    state: ['', Validators.required],
    country: ['', Validators.required],
    postalCode: ['', Validators.required],
    resubmissionComment: [''],
    dynamicFields: this.fb.group({}),
  });

  async ngOnInit(): Promise<void> {
    const [cfg, dash] = await Promise.all([
      firstValueFrom(this.api.getPublicFieldConfigs()),
      firstValueFrom(this.api.getUserDashboard()),
    ]);
    this.dynamicFields.set(cfg.fields);
    const dynGroup = this.form.get('dynamicFields') as ReturnType<typeof this.fb.group>;
    for (const f of cfg.fields) {
      dynGroup.addControl(
        f.fieldKey,
        this.fb.control(dash.record.dynamicFields?.[f.fieldKey] || ''),
      );
    }

    this.record.set(dash.record);
    this.form.patchValue({
      fullName: dash.record.full_name,
      dob: dash.record.dob || '',
      address: dash.record.address,
      city: dash.record.city,
      district: dash.record.district,
      state: dash.record.state,
      country: dash.record.country,
      postalCode: dash.record.postal_code,
    });
  }

  onFile(event: Event, kind: 'photo' | 'idproof'): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      this.toast.error('File Too Large', 'Maximum file size is 2 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const val = String(reader.result || '');
      if (kind === 'photo') {
        this.photoData.set(val);
        this.photoPreview.set(val);
      } else {
        this.idProofData.set(val);
        this.toast.info('Document Ready', `${file.name} attached for upload.`);
      }
    };
    reader.readAsDataURL(file);
  }

  async saveOrResubmit(): Promise<void> {
    const rec = this.record();
    if (!rec || this.form.invalid) return;
    this.saving.set(true);
    try {
      const payload = {
        ...this.form.value,
        profilePhotoData: this.photoData(),
        idProofData: this.idProofData(),
      };
      if (rec.approval_status === 'RESUBMISSION_REQUIRED') {
        await firstValueFrom(this.api.resubmitApplication(payload));
        this.toast.success('Resubmitted', 'Your application has returned to PENDING review.');
      } else {
        await firstValueFrom(this.api.updateUserProfile(payload));
        this.toast.success('Profile Updated', 'Your changes have been saved.');
      }
      const dash = await firstValueFrom(this.api.getUserDashboard());
      this.record.set(dash.record);
      await this.auth.refreshProfile();
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Failed to save changes.';
      this.toast.error('Error', msg);
    } finally {
      this.saving.set(false);
    }
  }
}
