# Design Document

## Overview

Bổ sung vai trò `DEPARTMENT_HEAD` vào hệ thống phân quyền hiện có. Thay đổi tập trung vào 4 lớp:

1. **Entity / DB** — thêm giá trị enum mới vào `UserRole`
2. **Guard** — mở rộng `RolesGuard` để hiểu scope theo khoa
3. **Service** — thêm logic kiểm tra scope trong `UsersService` và `DocumentsService`
4. **Controller / DTO** — thêm endpoint `PATCH /users/:id/role` và cập nhật các endpoint hiện có

Không có dependency mới nào được thêm vào.

---

## Architecture

### Phân cấp vai trò mới

```
ADMIN
 ├── Quản lý toàn bộ users (tạo, sửa role, kích hoạt/vô hiệu)
 ├── Duyệt/từ chối tài liệu toàn hệ thống
 └── Xem toàn bộ tài liệu

DEPARTMENT_HEAD
 ├── Xem users trong khoa mình
 ├── Kích hoạt/vô hiệu users trong khoa mình
 ├── Duyệt/từ chối tài liệu trong khoa mình
 └── Xem tài liệu trong khoa mình

USER
 ├── Upload tài liệu
 └── Xem tài liệu do mình upload
```

### Request flow cho DEPARTMENT_HEAD

```
Request → JwtAuthGuard (xác thực JWT)
        → RolesGuard (kiểm tra role có trong @Roles() không)
        → Controller
        → Service (kiểm tra department scope)
        → Repository
```

---

## Components

### 1. `UserRole` enum (user.entity.ts)

Thêm giá trị mới `DEPARTMENT_HEAD`:

```typescript
export enum UserRole {
  USER = 'user',
  DEPARTMENT_HEAD = 'department_head',
  ADMIN = 'admin',
}
```

Không cần migration thay đổi kiểu column — MySQL `ENUM` sẽ được cập nhật thông qua `synchronize: true` hoặc migration thêm giá trị.

---

### 2. `RolesGuard` — không thay đổi

Guard hiện tại đã đúng: kiểm tra `requiredRoles.includes(user.role)`. Việc thêm `DEPARTMENT_HEAD` vào `@Roles()` decorator là đủ cho các route cần mở cho vai trò này. Kiểm tra scope theo khoa được thực hiện ở tầng service, không phải guard.

---

### 3. `UpdateUserRoleDto` (mới)

```typescript
// src/users/dto/update-user-role.dto.ts
export class UpdateUserRoleDto {
  @IsEnum(UserRole)
  role: UserRole;

  @IsUUID()
  @IsOptional()
  departmentId?: string;
}
```

**Validation rule:** Nếu `role === 'department_head'` thì `departmentId` là bắt buộc. Implemented bằng custom class-validator hoặc kiểm tra trong service.

---

### 4. `UsersService` — các thay đổi

#### 4a. Thêm method `updateRole()`

```typescript
async updateRole(targetId: string, dto: UpdateUserRoleDto, actor: AuthUser): Promise<User>
```

- Chỉ ADMIN mới gọi được (enforced tại controller level)
- Nếu `dto.role === DEPARTMENT_HEAD` và `dto.departmentId` là null → ném `BadRequestException`
- Ghi audit log với `action = 'role_change'`, metadata `{ oldRole, newRole, departmentId }`

#### 4b. Thêm method `findByDepartment()`

```typescript
async findByDepartment(departmentId: string): Promise<User[]>
```

Trả về users có `department.id = departmentId`, loại trừ ADMIN accounts.

#### 4c. Sửa `findAll()` — phân quyền theo role

Controller sẽ gọi method phù hợp tùy theo role của người dùng hiện tại. Giữ nguyên `findAll()` cho ADMIN, thêm `findByDepartment()` cho DEPARTMENT_HEAD.

#### 4d. Sửa `setActive()` — kiểm tra scope

```typescript
async setActive(id: string, isActive: boolean, actor: AuthUser): Promise<User>
```

- Nếu `actor.role === DEPARTMENT_HEAD`: kiểm tra target user có cùng department không → nếu không → `ForbiddenException`
- Không cho phép DEPARTMENT_HEAD tác động vào ADMIN accounts
- Ghi audit log với `action = 'set_active'`

---

### 5. `DocumentsService` — các thay đổi

#### 5a. `findPendingQueue()` — thêm scope

```typescript
findPendingQueue(user: AuthUser)
```

- `ADMIN`: trả về toàn bộ pending như hiện tại
- `DEPARTMENT_HEAD`: thêm filter `department.id = user.departmentId`

#### 5b. `approve()` và `reject()` — kiểm tra scope

Cả hai method nhận `user: AuthUser`. Trước khi xử lý:

```typescript
if (user.role === UserRole.DEPARTMENT_HEAD) {
  if (!doc.department || doc.department.id !== user.departmentId) {
    throw new ForbiddenException('Bạn chỉ có thể duyệt tài liệu trong khoa mình');
  }
}
```

#### 5c. `search()` — thêm case DEPARTMENT_HEAD

```typescript
if (user.role === UserRole.ADMIN) {
  // lọc theo departmentId nếu có trong query
} else if (user.role === UserRole.DEPARTMENT_HEAD) {
  // luôn filter theo user.departmentId (scope cứng)
  qb.andWhere('department.id = :deptId', { deptId: user.departmentId });
} else {
  // USER: chỉ thấy file của mình
  qb.andWhere('uploader.id = :uploaderId', { uploaderId: user.id });
}
```

#### 5d. `getFileForDownload()` — thêm case DEPARTMENT_HEAD

```typescript
const isDeptHead = user.role === UserRole.DEPARTMENT_HEAD;
const isSameDept = doc.department?.id === user.departmentId;
if (!isOwner && !isAdmin && !(isDeptHead && isSameDept)) {
  throw new ForbiddenException('Bạn không có quyền tải file này');
}
```

---

### 6. `UsersController` — các thay đổi

#### 6a. Thêm endpoint `PATCH /users/:id/role`

```typescript
@Patch(':id/role')
@Roles(UserRole.ADMIN)
updateRole(
  @Param('id') id: string,
  @Body() dto: UpdateUserRoleDto,
  @CurrentUser() admin,
) {
  return this.service.updateRole(id, dto, admin);
}
```

#### 6b. Sửa `GET /users` — phân quyền theo role

```typescript
@Get()
@Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
findAll(@CurrentUser() user) {
  if (user.role === UserRole.ADMIN) return this.service.findAll();
  return this.service.findByDepartment(user.departmentId);
}
```

#### 6c. Sửa `PATCH /users/:id/active` — truyền actor

```typescript
@Patch(':id/active')
@Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
setActive(
  @Param('id') id: string,
  @Body('isActive') isActive: boolean,
  @CurrentUser() actor,
) {
  return this.service.setActive(id, isActive, actor);
}
```

---

### 7. `DocumentsController` — các thay đổi

```typescript
// Mở rộng @Roles cho DEPARTMENT_HEAD
@Get('pending')
@Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
pendingQueue(@CurrentUser() user) {
  return this.service.findPendingQueue(user);
}

@Patch(':id/approve')
@Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
approve(@Param('id') id: string, @CurrentUser() user) {
  return this.service.approve(id, user);
}

@Patch(':id/reject')
@Roles(UserRole.ADMIN, UserRole.DEPARTMENT_HEAD)
reject(@Param('id') id: string, @Body() dto: RejectDocumentDto, @CurrentUser() user) {
  return this.service.reject(id, user, dto.reason);
}
```

---

## Data Models

### Thay đổi DB duy nhất: Cột `role` trong bảng `users`

| Hiện tại | Sau khi thay đổi |
|---|---|
| `ENUM('user','admin')` | `ENUM('user','department_head','admin')` |

SQL migration thủ công (nếu không dùng `synchronize`):

```sql
ALTER TABLE users MODIFY COLUMN role ENUM('user','department_head','admin') NOT NULL DEFAULT 'user';
```

Không thay đổi cấu trúc bảng nào khác. Cột `department_id` trong `users` đã tồn tại.

---

## API Endpoints

| Method | Path | Roles được phép | Mô tả |
|---|---|---|---|
| `POST` | `/users` | ADMIN | Tạo tài khoản mới |
| `GET` | `/users` | ADMIN, DEPARTMENT_HEAD | ADMIN: tất cả; DeptHead: khoa mình |
| `PATCH` | `/users/:id/role` | ADMIN | Thay đổi vai trò |
| `PATCH` | `/users/:id/active` | ADMIN, DEPARTMENT_HEAD | DeptHead: chỉ khoa mình |
| `GET` | `/documents/pending` | ADMIN, DEPARTMENT_HEAD | DeptHead: chỉ khoa mình |
| `PATCH` | `/documents/:id/approve` | ADMIN, DEPARTMENT_HEAD | DeptHead: chỉ khoa mình |
| `PATCH` | `/documents/:id/reject` | ADMIN, DEPARTMENT_HEAD | DeptHead: chỉ khoa mình |
| `GET` | `/documents/search` | ALL authenticated | Scope theo role |
| `GET` | `/documents/:id/download` | Owner, ADMIN, DEPARTMENT_HEAD (same dept) | |

---

## Security Considerations

- **Scope enforcement tại service layer**: Guard chỉ kiểm tra role có trong whitelist không. Kiểm tra department scope luôn nằm ở service, không bao giờ chỉ dựa vào guard.
- **JWT payload** đã chứa `departmentId` từ `auth.service.ts` → không cần thêm DB call trong mỗi request.
- **DEPARTMENT_HEAD không thể tác động vào ADMIN accounts**: Kiểm tra `target.role === ADMIN → ForbiddenException`.
- **Tài liệu không có department**: Chỉ ADMIN xử lý được — DEPARTMENT_HEAD bị chặn ở service.
