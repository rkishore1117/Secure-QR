from rest_framework.permissions import BasePermission


class IsSuperAdmin(BasePermission):
    def has_permission(self, request, view):
        return bool(
            request.user
            and request.user.is_authenticated
            and request.user.is_active
            and request.user.role == "SUPER_ADMIN"
        )


class HasAdminPermission(BasePermission):
    required_permission = None

    def has_permission(self, request, view):
        user = request.user
        if not user or not user.is_authenticated or not user.is_active:
            return False
        if user.role == "SUPER_ADMIN":
            return True
        if user.role != "ADMIN" or not hasattr(user, "admin_profile"):
            return False
        perm = getattr(view, "required_permission", self.required_permission)
        if not perm:
            return True
        return user.admin_profile.permissions.filter(code=perm).exists()
