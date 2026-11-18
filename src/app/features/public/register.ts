import {ChangeDetectionStrategy, Component, OnDestroy, OnInit, inject, signal} from '@angular/core';
import {FormBuilder, ReactiveFormsModule, Validators} from '@angular/forms';
import {RouterLink} from '@angular/router';
import {MatIconModule} from '@angular/material/icon';
import {Subscription, firstValueFrom} from 'rxjs';
import {ApiService} from '../../core/services/api.service';
import {ToastService} from '../../core/services/toast.service';
import {DynamicFieldConfig} from '../../core/models/types';

@Component({
  selector: 'app-register',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, MatIconModule],
  template: `
    <div class="min-h-screen bg-slate-50 text-slate-900">
      <!-- Compact Header -->
      <header class="border-b border-slate-200 bg-white">
        <div class="mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-4 px-4 sm:px-6">
          <a routerLink="/" class="flex items-center gap-2.5 text-base font-bold text-[#0F172A] font-display whitespace-nowrap">
            <img
              src="/assets/images/brand_shield_emblem_1794911274112.jpg"
              alt="Secure QR"
              class="h-8 w-8 rounded-lg object-cover"
              referrerpolicy="no-referrer"
            />
            <span>Secure QR</span>
          </a>
          <div class="flex items-center gap-3">
            <a routerLink="/login" class="text-xs sm:text-sm font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap">
              Already registered? Sign In
            </a>
          </div>
        </div>
      </header>

      <main class="mx-auto max-w-[960px] px-4 py-8 sm:px-6 lg:py-10">
        @if (submittedResult(); as res) {
          <div class="rounded-xl border border-slate-200 bg-white p-6 sm:p-8 shadow-sm">
            <div class="flex items-start gap-4">
              <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
                <mat-icon class="text-[28px]!">task_alt</mat-icon>
              </div>
              <div class="min-w-0 flex-1">
                <h1 class="fluid-page-title font-bold text-[#0F172A] font-display">
                  Registration Submitted Successfully
                </h1>
                <p class="mt-2 text-sm text-slate-600">
                  {{ res.message }}
                </p>

                <div class="mt-6 grid grid-cols-1 gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-3">
                  <div>
                    <p class="text-xs font-medium text-slate-500">Registration ID</p>
                    <p class="mt-1 font-mono text-sm font-bold text-[#0F172A] tabular-nums">
                      {{ res.registrationId }}
                    </p>
                  </div>
                  <div>
                    <p class="text-xs font-medium text-slate-500">Application Status</p>
                    <p class="mt-1 text-sm font-semibold text-amber-700">{{ res.status }}</p>
                  </div>
                  <div>
                    <p class="text-xs font-medium text-slate-500">QR Credential</p>
                    <p class="mt-1 text-sm font-medium text-slate-700">Issued upon Admin approval</p>
                  </div>
                </div>

                <div class="mt-6 flex flex-col gap-3 sm:flex-row">
                  <a
                    routerLink="/login"
                    class="touch-target inline-flex items-center justify-center gap-2 rounded-lg bg-[#0F172A] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#1E3A5F]"
                  >
                    <mat-icon class="text-[18px]!">login</mat-icon>
                    <span>Sign In to User Portal</span>
                  </a>
                  <a
                    routerLink="/"
                    class="touch-target inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    <span>Return Home</span>
                  </a>
                </div>
              </div>
            </div>
          </div>
        } @else {
          <div class="mb-6">
            <p class="text-xs font-semibold text-[#1E3A5F]">{{ organizationName() }}</p>
            <h1 class="mt-1 fluid-page-title font-bold text-[#0F172A] font-display">
              Member Sign-Up
            </h1>
            <p class="mt-1 text-sm text-slate-600">
              Share your contact details, verify your email address with a one-time code, and upload a photo and ID document for quick team approval.
            </p>
          </div>

          @if (runtimeNotice(); as notice) {
            <div class="mb-6 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900">
              <p class="font-semibold">Runtime Configuration Notice</p>
              <p class="mt-1 leading-relaxed">{{ notice }}</p>
            </div>
          }

          <form [formGroup]="form" (ngSubmit)="submitRegistration()" class="space-y-6">
            <!-- Section 1: Account & Identity -->
            <section class="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
              <h2 class="text-base font-bold text-[#0F172A] font-display">01. Personal &amp; Account Details</h2>
              <div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div class="sm:col-span-2">
                  <label for="reg-fullname" class="block text-xs font-semibold text-slate-700 mb-1.5">
                    Full Name <span class="text-red-600">*</span>
                  </label>
                  <input
                    id="reg-fullname"
                    type="text"
                    formControlName="fullName"
                    placeholder="e.g., Jordan Vance"
                    class="w-full h-11 rounded-lg border border-slate-300 px-3.5 text-sm text-slate-900 focus:border-[#0F172A] focus:outline-none"
                  />
                </div>

                <div>
                  <label for="reg-email" class="block text-xs font-semibold text-slate-700 mb-1.5">
                    Email Address <span class="text-red-600">*</span>
                  </label>
                  <input
                    id="reg-email"
                    type="email"
                    formControlName="email"
                    (blur)="checkDuplicates()"
                    [readonly]="Boolean(otpVerifiedId())"
                    placeholder="name@organization.org"
                    class="w-full h-11 rounded-lg border border-slate-300 px-3.5 text-sm text-slate-900 focus:border-[#0F172A] focus:outline-none read-only:bg-slate-100"
                  />
                  @if (emailTaken()) {
                    <p class="mt-1 text-xs font-medium text-red-600">This email is already registered.</p>
                  }
                </div>

                <div>
                  <label for="reg-mobile" class="block text-xs font-semibold text-slate-700 mb-1.5">
                    Mobile Number (Contact) <span class="text-red-600">*</span>
                  </label>
                  <input
                    id="reg-mobile"
                    type="tel"
                    formControlName="mobile"
                    (blur)="checkDuplicates()"
                    placeholder="+15550192834"
                    class="w-full h-11 rounded-lg border border-slate-300 px-3.5 font-mono text-sm text-slate-900 focus:border-[#0F172A] focus:outline-none"
                  />
                  @if (mobileTaken()) {
                    <p class="mt-1 text-xs font-medium text-red-600">This mobile number is already registered.</p>
                  }
                </div>

                <div>
                  <label for="reg-password" class="block text-xs font-semibold text-slate-700 mb-1.5">
                    Account Password (min 8 chars) <span class="text-red-600">*</span>
                  </label>
                  <div class="relative">
                    <input
                      id="reg-password"
                      [type]="showPassword() ? 'text' : 'password'"
                      formControlName="password"
                      placeholder="Minimum 8 characters"
                      class="w-full h-11 rounded-lg border border-slate-300 pl-3.5 pr-11 text-sm text-slate-900 focus:border-[#0F172A] focus:outline-none"
                    />
                    <button
                      type="button"
                      (click)="showPassword.set(!showPassword())"
                      [attr.aria-label]="showPassword() ? 'Hide password' : 'Show password'"
                      class="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-slate-500 hover:text-slate-800"
                    >
                      <mat-icon class="text-[20px]!">{{ showPassword() ? 'visibility_off' : 'visibility' }}</mat-icon>
                    </button>
                  </div>
                </div>

                <div>
                  <label for="reg-dob" class="block text-xs font-semibold text-slate-700 mb-1.5">
                    Date of Birth (Optional)
                  </label>
                  <input
                    id="reg-dob"
                    type="date"
                    formControlName="dob"
                    class="w-full h-11 rounded-lg border border-slate-300 px-3.5 text-sm text-slate-900 focus:border-[#0F172A] focus:outline-none"
                  />
                </div>

                <div>
                  <label for="reg-gender" class="block text-xs font-semibold text-slate-700 mb-1.5">
                    Gender (Optional)
                  </label>
                  <select
                    id="reg-gender"
                    formControlName="gender"
                    class="w-full h-11 rounded-lg border border-slate-300 bg-white px-3.5 text-sm text-slate-900 focus:border-[#0F172A] focus:outline-none"
                  >
                    <option value="">Prefer not to specify</option>
                    <option value="Female">Female</option>
                    <option value="Male">Male</option>
                    <option value="Non-binary">Non-binary</option>
                  </select>
                </div>
              </div>
            </section>

            <!-- Section 2: Email OTP Verification -->
            <section class="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <h2 class="text-base font-bold text-[#0F172A] font-display">02. Email OTP Verification</h2>
                @if (otpVerifiedId()) {
                  <span class="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                    <mat-icon class="text-[16px]!">verified</mat-icon>
                    <span>Email Verified</span>
                  </span>
                }
              </div>

              <div class="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
                <div class="min-w-0">
                  <p class="text-xs font-semibold text-slate-700">Verification Email Recipient</p>
                  <p class="mt-0.5 font-mono text-xs text-slate-600 truncate">
                    {{ form.value.email || 'Enter your email address in Section 01 above' }}
                  </p>
                </div>

                @if (!otpVerifiedId()) {
                  <button
                    type="button"
                    (click)="sendOtp()"
                    [disabled]="sendingOtp() || resendCooldown() > 0 || emailTaken()"
                    class="touch-target w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-lg bg-[#1E3A5F] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#0F172A] disabled:opacity-50 whitespace-nowrap"
                  >
                    <mat-icon class="text-[18px]!">mail</mat-icon>
                    @if (resendCooldown() > 0) {
                      <span>Resend in {{ resendCooldown() }}s</span>
                    } @else if (otpSent()) {
                      <span>Resend Email OTP</span>
                    } @else {
                      <span>Send Email OTP</span>
                    }
                  </button>
                }
              </div>

              @if (otpErrorMsg()) {
                <div class="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs font-medium text-red-800">
                  {{ otpErrorMsg() }}
                </div>
              }

              @if (otpSent() && !otpVerifiedId()) {
                <div class="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-2">
                  @if (emailNotice()) {
                    <p class="text-xs font-medium text-slate-700">
                      {{ emailNotice() }}
                    </p>
                  }
                  <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
                    <div class="flex-1 max-w-xs">
                      <label for="reg-otp" class="block text-xs font-semibold text-slate-700 mb-1.5">
                        Enter 6-Digit Email Code
                      </label>
                      <input
                        id="reg-otp"
                        type="text"
                        maxlength="6"
                        formControlName="otpCode"
                        placeholder="000000"
                        class="w-full h-11 rounded-lg border border-slate-300 bg-white px-3.5 font-mono text-base tracking-widest text-slate-900 focus:border-[#0F172A] focus:outline-none"
                      />
                    </div>
                    <button
                      type="button"
                      (click)="verifyOtp()"
                      [disabled]="verifyingOtp()"
                      class="touch-target inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-700 px-5 py-2.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50 whitespace-nowrap"
                    >
                      <mat-icon class="text-[18px]!">check_circle</mat-icon>
                      <span>{{ verifyingOtp() ? 'Verifying...' : 'Verify Email Code' }}</span>
                    </button>
                  </div>
                </div>
              }
            </section>

            <!-- Section 3: Address Details -->
            <section class="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
              <h2 class="text-base font-bold text-[#0F172A] font-display">03. Residential / Organization Address</h2>
              <div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div class="sm:col-span-2">
                  <label for="reg-address" class="block text-xs font-semibold text-slate-700 mb-1.5">
                    Street Address <span class="text-red-600">*</span>
                  </label>
                  <input
                    id="reg-address"
                    type="text"
                    formControlName="address"
                    placeholder="Street, building, suite number"
                    class="w-full h-11 rounded-lg border border-slate-300 px-3.5 text-sm text-slate-900 focus:border-[#0F172A] focus:outline-none"
                  />
                </div>
                <div>
                  <label for="reg-city" class="block text-xs font-semibold text-slate-700 mb-1.5">
                    City <span class="text-red-600">*</span>
                  </label>
                  <input
                    id="reg-city"
                    type="text"
                    formControlName="city"
                    class="w-full h-11 rounded-lg border border-slate-300 px-3.5 text-sm text-slate-900 focus:border-[#0F172A] focus:outline-none"
                  />
                </div>
                <div>
                  <label for="reg-district" class="block text-xs font-semibold text-slate-700 mb-1.5">
                    District / County <span class="text-red-600">*</span>
                  </label>
                  <input
                    id="reg-district"
                    type="text"
                    formControlName="district"
                    class="w-full h-11 rounded-lg border border-slate-300 px-3.5 text-sm text-slate-900 focus:border-[#0F172A] focus:outline-none"
                  />
                </div>
                <div>
                  <label for="reg-state" class="block text-xs font-semibold text-slate-700 mb-1.5">
                    State / Province <span class="text-red-600">*</span>
                  </label>
                  <input
                    id="reg-state"
                    type="text"
                    formControlName="state"
                    class="w-full h-11 rounded-lg border border-slate-300 px-3.5 text-sm text-slate-900 focus:border-[#0F172A] focus:outline-none"
                  />
                </div>
                <div>
                  <label for="reg-country" class="block text-xs font-semibold text-slate-700 mb-1.5">
                    Country <span class="text-red-600">*</span>
                  </label>
                  <input
                    id="reg-country"
                    type="text"
                    formControlName="country"
                    class="w-full h-11 rounded-lg border border-slate-300 px-3.5 text-sm text-slate-900 focus:border-[#0F172A] focus:outline-none"
                  />
                </div>
                <div>
                  <label for="reg-postal" class="block text-xs font-semibold text-slate-700 mb-1.5">
                    Postal Code <span class="text-red-600">*</span>
                  </label>
                  <input
                    id="reg-postal"
                    type="text"
                    formControlName="postalCode"
                    class="w-full h-11 rounded-lg border border-slate-300 font-mono text-sm text-slate-900 focus:border-[#0F172A] focus:outline-none"
                  />
                </div>
              </div>
            </section>

            <!-- Section 4: Photo, ID Document & Dynamic Fields -->
            <section class="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
              <h2 class="text-base font-bold text-[#0F172A] font-display">04. Identity Documents &amp; Organization Fields</h2>
              <div class="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-2">
                <div>
                  <label for="reg-photo" class="block text-xs font-semibold text-slate-700 mb-1.5">
                    Profile Photo (PNG/JPG, max 2 MB) <span class="text-red-600">*</span>
                  </label>
                  <input
                    id="reg-photo"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    (change)="onFileSelected($event, 'photo')"
                    class="block w-full text-xs text-slate-600 file:mr-3 file:rounded-lg file:border file:border-slate-300 file:bg-slate-50 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-slate-700 hover:file:bg-slate-100"
                  />
                  @if (photoPreview()) {
                    <img
                      [src]="photoPreview()"
                      alt="Profile Preview"
                      class="mt-3 h-20 w-20 rounded-lg border border-slate-200 object-cover"
                      referrerpolicy="no-referrer"
                    />
                  }
                </div>

                <div>
                  <label for="reg-idtype" class="block text-xs font-semibold text-slate-700 mb-1.5">
                    ID Proof Type <span class="text-red-600">*</span>
                  </label>
                  <select
                    id="reg-idtype"
                    formControlName="idProofType"
                    class="w-full h-11 rounded-lg border border-slate-300 bg-white px-3.5 text-sm text-slate-900 focus:border-[#0F172A] focus:outline-none mb-3"
                  >
                    <option value="National Passport">National Passport</option>
                    <option value="Driver License">Driver License</option>
                    <option value="National ID">National ID</option>
                    <option value="Employee Credential">Employee Credential</option>
                  </select>

                  <label for="reg-idproof" class="block text-xs font-semibold text-slate-700 mb-1.5">
                    Upload ID Proof (PNG/JPG/PDF, max 2 MB)
                    @if (idProofRequired()) {
                      <span class="text-red-600">*</span>
                    }
                  </label>
                  <input
                    id="reg-idproof"
                    type="file"
                    accept="image/png,image/jpeg,image/webp,application/pdf"
                    (change)="onFileSelected($event, 'idproof')"
                    class="block w-full text-xs text-slate-600 file:mr-3 file:rounded-lg file:border file:border-slate-300 file:bg-slate-50 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-slate-700 hover:file:bg-slate-100"
                  />
                  @if (idProofName()) {
                    <p class="mt-2 text-xs text-emerald-700 font-medium">Attached: {{ idProofName() }}</p>
                  }
                </div>
              </div>

              @if (dynamicFields().length > 0) {
                <div class="mt-5 border-t border-slate-200 pt-5 grid grid-cols-1 gap-4 sm:grid-cols-2" formGroupName="dynamicFields">
                  @for (field of dynamicFields(); track field.id) {
                    <div>
                      <label [for]="'dyn-' + field.fieldKey" class="block text-xs font-semibold text-slate-700 mb-1.5">
                        {{ field.label }}
                        @if (field.isRequired) {
                          <span class="text-red-600">*</span>
                        }
                      </label>
                      @if (field.fieldType === 'select') {
                        <select
                          [id]="'dyn-' + field.fieldKey"
                          [formControlName]="field.fieldKey"
                          class="w-full h-11 rounded-lg border border-slate-300 bg-white px-3.5 text-sm text-slate-900 focus:border-[#0F172A] focus:outline-none"
                        >
                          <option value="">Select {{ field.label }}</option>
                          @for (opt of field.options; track opt) {
                            <option [value]="opt">{{ opt }}</option>
                          }
                        </select>
                      } @else {
                        <input
                          [id]="'dyn-' + field.fieldKey"
                          [type]="field.fieldType === 'date' ? 'date' : 'text'"
                          [formControlName]="field.fieldKey"
                          class="w-full h-11 rounded-lg border border-slate-300 px-3.5 text-sm text-slate-900 focus:border-[#0F172A] focus:outline-none"
                        />
                      }
                    </div>
                  }
                </div>
              }
            </section>

            <!-- Section 5: Consent & Submit -->
            <section class="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
              <div class="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs leading-relaxed text-slate-600">
                <strong class="text-slate-900">Privacy &amp; Verification Notice:</strong>
                Submitted identity records and photographs are encrypted in transit and inspected solely by authorized administrators for credential issuance. QR codes contain only opaque 256-bit cryptographic tokens and never embed personal data.
              </div>

              <label class="mt-4 flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  formControlName="consentAccepted"
                  class="mt-0.5 h-5 w-5 rounded border-slate-300 text-[#0F172A] focus:ring-[#0F172A]"
                />
                <span class="text-xs sm:text-sm text-slate-700">
                  I certify that the submitted information and identification documents are accurate, and I consent to identity verification processing.
                </span>
              </label>

              @if (errorMsg()) {
                <div class="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs font-medium text-red-800">
                  {{ errorMsg() }}
                </div>
              }

              <div class="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <span class="text-xs text-slate-500">
                  Status starts as PENDING until Admin approval.
                </span>
                <button
                  type="submit"
                  [disabled]="submitting()"
                  class="touch-target inline-flex items-center justify-center gap-2 rounded-lg bg-[#0F172A] px-6 py-3 text-sm font-semibold text-white hover:bg-[#1E3A5F] disabled:opacity-50 whitespace-nowrap"
                >
                  <mat-icon class="text-[20px]!">send</mat-icon>
                  <span>{{ submitting() ? 'Submitting Application...' : 'Submit Registration' }}</span>
                </button>
              </div>
            </section>
          </form>
        }
      </main>
    </div>
  `,
})
export class Register implements OnInit, OnDestroy {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  private cooldownTimer: ReturnType<typeof setInterval> | null = null;
  private emailSub: Subscription | null = null;
  private lastOtpEmail = '';

  protected readonly organizationName = signal('Secure QR Verification Authority');
  protected readonly idProofRequired = signal(true);
  protected readonly dynamicFields = signal<DynamicFieldConfig[]>([]);

  protected readonly emailTaken = signal(false);
  protected readonly mobileTaken = signal(false);
  protected readonly otpSent = signal(false);
  protected readonly sendingOtp = signal(false);
  protected readonly verifyingOtp = signal(false);
  protected readonly otpVerifiedId = signal<number | null>(null);
  protected readonly otpErrorMsg = signal<string | null>(null);
  protected readonly emailNotice = signal<string | null>(null);
  protected readonly runtimeNotice = signal<string | null>(null);
  protected readonly resendCooldown = signal(0);

  protected readonly photoPreview = signal<string | null>(null);
  protected readonly photoData = signal<string | null>(null);
  protected readonly idProofData = signal<string | null>(null);
  protected readonly idProofName = signal<string | null>(null);

  protected readonly submitting = signal(false);
  protected readonly showPassword = signal(false);
  protected readonly errorMsg = signal<string | null>(null);
  protected readonly submittedResult = signal<{
    registrationId: string;
    status: string;
    message: string;
  } | null>(null);

  protected readonly Boolean = Boolean;

  protected readonly form = this.fb.group({
    fullName: ['', [Validators.required, Validators.minLength(2)]],
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(8)]],
    mobile: ['', [Validators.required, Validators.pattern(/^\+?[0-9]{8,16}$/)]],
    otpCode: [''],
    dob: [''],
    gender: [''],
    address: ['', Validators.required],
    city: ['', Validators.required],
    district: ['', Validators.required],
    state: ['', Validators.required],
    country: ['United States', Validators.required],
    postalCode: ['', Validators.required],
    idProofType: ['National Passport', Validators.required],
    consentAccepted: [false, Validators.requiredTrue],
    dynamicFields: this.fb.group({}),
  });

  async ngOnInit(): Promise<void> {
    this.emailSub = this.form.controls.email.valueChanges.subscribe((val) => {
      const normalized = String(val || '').trim().toLowerCase();
      if (!this.otpVerifiedId() && this.lastOtpEmail && normalized !== this.lastOtpEmail) {
        this.otpSent.set(false);
        this.emailNotice.set(null);
        this.otpErrorMsg.set(null);
        this.resendCooldown.set(0);
        this.form.patchValue({otpCode: ''}, {emitEvent: false});
        if (this.cooldownTimer) {
          clearInterval(this.cooldownTimer);
          this.cooldownTimer = null;
        }
      }
    });

    try {
      const [cfg, health] = await Promise.all([
        firstValueFrom(this.api.getPublicFieldConfigs()),
        firstValueFrom(this.api.getPublicHealth()).catch(() => null),
      ]);
      this.organizationName.set(cfg.organizationName);
      this.idProofRequired.set(cfg.idProofRequired);
      this.dynamicFields.set(cfg.fields);
      const dynGroup = this.form.get('dynamicFields') as ReturnType<typeof this.fb.group>;
      for (const f of cfg.fields) {
        dynGroup.addControl(
          f.fieldKey,
          this.fb.control('', f.isRequired ? Validators.required : []),
        );
      }

      if (health && (!health.databaseConnected || !health.emailConfigured)) {
        const issues: string[] = [];
        if (!health.databaseConnected) {
          issues.push(
            'Live MySQL database credentials (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME) are not configured on this host — applications on this instance will not reach your shared AWS RDS Admin Panel.',
          );
        }
        if (!health.emailConfigured) {
          issues.push(
            'Email OTP relay (EMAIL_HOST_USER/EMAIL_HOST_PASSWORD or BREVO_API_KEY/EMAIL_WEBHOOK_URL) is not configured on this host.',
          );
        }
        this.runtimeNotice.set(issues.join(' '));
      }
    } catch {
      // keep base form functional
    }
  }

  ngOnDestroy(): void {
    this.emailSub?.unsubscribe();
    if (this.cooldownTimer) {
      clearInterval(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  async checkDuplicates(): Promise<void> {
    const email = (this.form.value.email || '').trim();
    const mobile = (this.form.value.mobile || '').trim();
    if (!email && !mobile) return;
    try {
      const res = await firstValueFrom(this.api.checkAvailability(email, mobile));
      this.emailTaken.set(!res.emailAvailable);
      this.mobileTaken.set(!res.mobileAvailable);
    } catch {
      // ignore transient network check
    }
  }

  async sendOtp(): Promise<void> {
    const email = (this.form.value.email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      this.toast.error('Invalid Email', 'Enter a valid email address in Section 01 first.');
      return;
    }
    this.sendingOtp.set(true);
    this.emailNotice.set(null);
    this.otpErrorMsg.set(null);
    try {
      const res = await firstValueFrom(this.api.sendOtp(email, 'REGISTRATION'));
      if (res.emailDispatched) {
        this.lastOtpEmail = email;
        this.otpSent.set(true);
        const notice = `A 6-digit verification code has been sent to ${email}. Check your inbox or spam folder.`;
        this.emailNotice.set(notice);
        this.toast.success('Email OTP Sent', `Verification code sent to ${email}.`);
        this.startCooldown(30);
      } else {
        const notice = `Could not deliver verification email (${res.emailError || 'Email service unavailable'}).`;
        this.otpSent.set(false);
        this.otpErrorMsg.set(notice);
        this.toast.error('Email Delivery Failed', notice);
      }
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Could not send email OTP.';
      this.otpSent.set(false);
      this.otpErrorMsg.set(msg);
      this.toast.error('OTP Error', msg);
    } finally {
      this.sendingOtp.set(false);
    }
  }

  async verifyOtp(): Promise<void> {
    const email = (this.form.value.email || '').trim().toLowerCase();
    const otp = (this.form.value.otpCode || '').trim();
    if (!/^\d{6}$/.test(otp)) {
      this.toast.error('Invalid Code', 'Enter the 6-digit numeric verification code.');
      return;
    }
    this.verifyingOtp.set(true);
    try {
      const res = await firstValueFrom(this.api.verifyOtp(email, otp));
      if (res.verified) {
        this.otpVerifiedId.set(res.otpVerificationId);
        this.toast.success('Email Verified', 'Your email address has been verified.');
      }
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Email verification failed.';
      this.toast.error('Verification Failed', msg);
    } finally {
      this.verifyingOtp.set(false);
    }
  }

  onFileSelected(event: Event, kind: 'photo' | 'idproof'): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      this.toast.error('File Too Large', 'Maximum allowed file size is 2 MB.');
      input.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      if (kind === 'photo') {
        this.photoData.set(result);
        this.photoPreview.set(result);
      } else {
        this.idProofData.set(result);
        this.idProofName.set(file.name);
      }
    };
    reader.readAsDataURL(file);
  }

  async submitRegistration(): Promise<void> {
    this.errorMsg.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.errorMsg.set('Please complete all highlighted required fields and accept the privacy consent.');
      return;
    }
    if (this.emailTaken() || this.mobileTaken()) {
      this.errorMsg.set('Email or mobile number is already registered.');
      return;
    }
    if (!this.otpVerifiedId()) {
      this.errorMsg.set('Please verify your email address via OTP before submitting.');
      return;
    }
    if (!this.photoData()) {
      this.errorMsg.set('Please upload your profile photo.');
      return;
    }
    if (this.idProofRequired() && !this.idProofData()) {
      this.errorMsg.set('Please upload your ID proof document.');
      return;
    }

    this.submitting.set(true);
    try {
      const v = this.form.value;
      const res = await firstValueFrom(
        this.api.registerUser({
          fullName: v.fullName,
          email: v.email,
          password: v.password,
          mobile: v.mobile,
          otpVerificationId: this.otpVerifiedId(),
          dob: v.dob || null,
          gender: v.gender || null,
          address: v.address,
          city: v.city,
          district: v.district,
          state: v.state,
          country: v.country,
          postalCode: v.postalCode,
          idProofType: v.idProofType,
          profilePhotoData: this.photoData(),
          idProofData: this.idProofData(),
          dynamicFields: v.dynamicFields,
          consentAccepted: v.consentAccepted,
        }),
      );
      this.submittedResult.set({
        registrationId: res.registrationId,
        status: res.status,
        message: res.message,
      });
      this.toast.success('Application Submitted', `Registration ID: ${res.registrationId}`);
    } catch (err: unknown) {
      const msg = (err as {error?: {error?: string}})?.error?.error || 'Registration submission failed.';
      this.errorMsg.set(msg);
    } finally {
      this.submitting.set(false);
    }
  }

  private startCooldown(seconds: number): void {
    if (this.cooldownTimer) {
      clearInterval(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    this.resendCooldown.set(seconds);
    this.cooldownTimer = setInterval(() => {
      const next = this.resendCooldown() - 1;
      this.resendCooldown.set(Math.max(0, next));
      if (next <= 0 && this.cooldownTimer) {
        clearInterval(this.cooldownTimer);
        this.cooldownTimer = null;
      }
    }, 1000);
  }
}
