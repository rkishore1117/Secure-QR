from django.contrib import admin
from django.urls import include, path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView
from apps.accounts.views import AdminHealthCheckView, PublicHealthView

urlpatterns = [
    path("django-admin/", admin.site.urls),
    path("api/v1/public/health", PublicHealthView.as_view(), name="public-health"),
    path("api/v1/admin/health", AdminHealthCheckView.as_view(), name="admin-health"),
    path("api/v1/schema/", SpectacularAPIView.as_view(), name="schema"),
    path("api/v1/docs/", SpectacularSwaggerView.as_view(url_name="schema"), name="swagger-ui"),
    path("api/v1/auth/", include("apps.accounts.urls")),
    path("api/v1/", include("apps.registrations.urls")),
    path("api/v1/", include("apps.qr_management.urls")),
    path("api/v1/", include("apps.verification.urls")),
    path("api/v1/", include("apps.notifications.urls")),
    path("api/v1/", include("apps.exports.urls")),
    path("api/v1/", include("apps.audit_logs.urls")),
]
