# Implementation Tasks

## Task Overview

- [x] 1. Thêm `DEPARTMENT_HEAD` vào `UserRole` enum
- [x] 2. Tạo `UpdateUserRoleDto`
- [x] 3. Cập nhật `UsersService` — thêm `updateRole`, `findByDepartment`, sửa `setActive`
- [x] 4. Cập nhật `UsersController` — thêm endpoint role, mở quyền cho DEPARTMENT_HEAD
- [x] 5. Cập nhật `DocumentsService` — scope theo khoa cho DEPARTMENT_HEAD
- [x] 6. Cập nhật `DocumentsController` — mở endpoint cho DEPARTMENT_HEAD
- [x] 7. Chạy migration / cập nhật DB schema

---

## Task 1: Thêm `DEPARTMENT_HEAD` vào `UserRole` enum

**File:** `src/entities/user.entity.ts`

- [x] 1.1 Thêm `DEPARTMENT_HEAD = 'department_head'` vào enum `UserRole`
- [x] 1.2 Kiểm tra `create-user.dto.ts` — `@IsEnum(UserRole)` sẽ tự động chấp nhận giá trị mới

**Acceptance test:** `UserRole.DEPARTMENT_HEAD === 'department_head'`

---

## Task 2: Tạo `UpdateUserRoleDto`

**File mới:** `src/users/dto/update-user-role.dto.ts`

- [x] 2.1 Tạo class `UpdateUserRoleDto` với field `role: UserRole` (bắt buộc) và `departmentId?: string` (tùy chọn)
- [x] 2.2 Dùng `@IsEnum(UserRole)` cho `role`
- [x] 2.3 Dùng `@IsUUID()` và `@IsOptional()` cho `departmentId`

---

## Task 3: Cập nhật `UsersService`

**File:** `src/users/users.service.ts`

- [x] 3.1 Thêm interface `AuthUser` (hoặc import từ shared type) với `{ id, role, departmentId? }`
- [x] 3.2 Thêm method `updateRole(targetId, dto, actor)`:
  - Tìm user target, ném `NotFoundException` nếu không có
  - Nếu `dto.role === DEPARTMENT_HEAD` và `dto.departmentId` null → ném `BadRequestException('Trưởng khoa phải thuộc một khoa')`
  - Cập nhật `role` và `department` trong DB
  - Ghi audit log với `action = 'role_change'`, `metadata = { oldRole, newRole, departmentId }`
- [x] 3.3 Thêm method `findByDepartment(departmentId)`:
  - Query users có `department.id = departmentId`
  - Loại trừ users có `role = admin`
  - Include relation `department`
- [x] 3.4 Sửa `setActive(id, isActive)` → `setActive(id, isActive, actor: AuthUser)`:
  - Nếu `actor.role === DEPARTMENT_HEAD`:
    - Kiểm tra target user có cùng `department.id` với actor không → nếu không → `ForbiddenException`
    - Kiểm tra target user không phải ADMIN → nếu là ADMIN → `ForbiddenException`
  - Ghi audit log với `action = 'set_active'`, `metadata = { isActive }`
- [x] 3.5 Inject `AuditLog` repository vào `UsersService` (cần cập nhật `UsersModule` để import `AuditLog`)

---

## Task 4: Cập nhật `UsersController`

**File:** `src/users/users.controller.ts`

- [x] 4.1 Bỏ decorator `@Roles(UserRole.ADMIN)` ở class level (vì một số route cần DEPARTMENT_HEAD cũng truy cập được)
- [x] 4.2 Giữ `@UseGuards(JwtAuthGuard, RolesGuard)` ở class level
- [x] 4.3 Thêm `@Roles(UserRole.ADMIN)` lên route `POST /` (tạo user)
- [x] 4.4 Sửa route `GET /`:
  - Thêm `@Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)`
  - Nhận `@CurrentUser() user`
  - Nếu ADMIN → `this.service.findAll()`
  - Nếu DEPARTMENT_HEAD → `this.service.findByDepartment(user.departmentId)`
- [x] 4.5 Thêm route `PATCH /:id/role`:
  - `@Roles(UserRole.ADMIN)`
  - Nhận `@Param('id')`, `@Body() dto: UpdateUserRoleDto`, `@CurrentUser() admin`
  - Gọi `this.service.updateRole(id, dto, admin)`
- [x] 4.6 Sửa route `PATCH /:id/active`:
  - Thêm `@Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)`
  - Thêm `@CurrentUser() actor` vào params
  - Gọi `this.service.setActive(id, isActive, actor)`

---

## Task 5: Cập nhật `DocumentsService`

**File:** `src/documents/documents.service.ts`

- [x] 5.1 Sửa `findPendingQueue()` → `findPendingQueue(user: AuthUser)`:
  - Nếu `user.role === ADMIN`: giữ nguyên logic hiện tại
  - Nếu `user.role === DEPARTMENT_HEAD`: thêm `.andWhere('department.id = :deptId', { deptId: user.departmentId })` — dùng `createQueryBuilder` thay vì `find()`
- [x] 5.2 Sửa `approve(id, admin)` → scope check cho DEPARTMENT_HEAD:
  - Sau khi `getOrFail(id)`, nếu `admin.role === DEPARTMENT_HEAD`:
    - Nếu `!doc.department` → `ForbiddenException('Tài liệu không thuộc khoa nào, chỉ Admin mới duyệt được')`
    - Nếu `doc.department.id !== admin.departmentId` → `ForbiddenException('Bạn chỉ có thể duyệt tài liệu trong khoa mình')`
- [x] 5.3 Sửa `reject(id, admin, reason)` → scope check tương tự Task 5.2
- [x] 5.4 Sửa `search()` — thêm case `DEPARTMENT_HEAD`:

  ```
  ADMIN → filter departmentId nếu có trong query (giữ nguyên)
  DEPARTMENT_HEAD → luôn filter department.id = user.departmentId
  USER → luôn filter uploader.id = user.id (giữ nguyên)
  ```

- [x] 5.5 Sửa `getFileForDownload()` — thêm case DEPARTMENT_HEAD:
  - Thêm: `const isDeptHeadSameDept = user.role === DEPARTMENT_HEAD && doc.department?.id === user.departmentId`
  - Điều kiện cho phép: `isOwner || isAdmin || isDeptHeadSameDept`

---

## Task 6: Cập nhật `DocumentsController`

**File:** `src/documents/documents.controller.ts`

- [x] 6.1 Sửa `GET /pending`:
  - Đổi `@Roles(UserRole.ADMIN)` → `@Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)`
  - Thêm `@CurrentUser() user` vào method signature
  - Gọi `this.service.findPendingQueue(user)` thay vì `findPendingQueue()`
- [x] 6.2 Sửa `PATCH /:id/approve`:
  - Đổi `@Roles(UserRole.ADMIN)` → `@Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)`
  - Đổi tên param `admin` → `user` để nhất quán
- [x] 6.3 Sửa `PATCH /:id/reject`:
  - Đổi `@Roles(UserRole.ADMIN)` → `@Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)`
  - Đổi tên param `admin` → `user`

---

## Task 7: Cập nhật `UsersModule` và DB schema

**Files:** `src/users/users.module.ts`, DB migration/synchronize

- [x] 7.1 Cập nhật `UsersModule`: thêm `AuditLog` vào `TypeOrmModule.forFeature([User, AuditLog])`
- [x] 7.2 Import `AuditLog` entity trong `users.module.ts`
- [x] 7.3 Nếu dùng `synchronize: true` (dev) → restart app là đủ, MySQL tự thêm `department_head` vào ENUM
- [x] 7.4 Nếu dùng migration production:
  ```sql
  ALTER TABLE users 
  MODIFY COLUMN role ENUM('user','department_head','admin') NOT NULL DEFAULT 'user';
  ```
- [x] 7.5 Build project (`npm run build`) để xác nhận không có lỗi TypeScript
