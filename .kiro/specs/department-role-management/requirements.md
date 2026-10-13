# Requirements Document

## Introduction

Hệ thống LTHS hiện tại chỉ có hai vai trò: `ADMIN` và `USER`. Tính năng này bổ sung vai trò trung gian `DEPARTMENT_HEAD` (Trưởng Khoa), cho phép phân quyền quản lý theo phạm vi khoa. Admin hệ thống có thể gán/thay đổi vai trò cho bất kỳ tài khoản nào. Trưởng Khoa chỉ quản lý được tài khoản và duyệt tài liệu trong phạm vi khoa mình.

## Glossary

| Thuật ngữ | Định nghĩa |
|---|---|
| ADMIN | Quản trị viên hệ thống, có toàn quyền |
| DEPARTMENT_HEAD | Trưởng Khoa, quản lý trong phạm vi khoa mình |
| USER | Người dùng thường, chỉ tải lên và xem tài liệu của mình |
| Phân quyền (Role Assignment) | Hành động ADMIN gán vai trò cho một tài khoản |
| Phạm vi khoa (Department Scope) | Giới hạn quyền hạn của DEPARTMENT_HEAD chỉ trong khoa mà họ thuộc về |
| Hàng chờ duyệt (Pending Queue) | Danh sách tài liệu có trạng thái PENDING chờ được xử lý |

---

## Requirements

### Requirement 1: Mở rộng hệ thống vai trò

**User Story:** As a system architect, I want a three-tier role system (ADMIN, DEPARTMENT_HEAD, USER), so that permission boundaries are clearly defined and enforced.

#### Acceptance Criteria

1. WHEN the system is updated, THEN the `UserRole` enum SHALL contain exactly three values: `admin`, `department_head`, và `user`.
2. WHEN a user has role `department_head`, THEN they SHALL have a non-null `department` association on their account.
3. WHEN a user has role `admin`, THEN their `department` field MAY be null (không bắt buộc thuộc khoa nào).
4. WHEN a user has role `user`, THEN their `department` field SHALL be non-null (người dùng thường phải thuộc một khoa).
5. IF a `department_head` account's department is set to null, THEN the system SHALL reject the operation with a 400 Bad Request error.

#### Correctness Properties

- **P1-Role-Completeness**: Tất cả tài khoản trong hệ thống đều phải có role là một trong ba giá trị hợp lệ.
- **P1-DeptHead-Constraint**: Với mọi user có `role = department_head`, `department` không được là null.

---

### Requirement 2: Admin phân quyền và quản lý tài khoản toàn hệ thống

**User Story:** As an ADMIN, I want to assign or change roles and departments for any user account, so that I can manage the entire organization's access control.

#### Acceptance Criteria

1. WHEN an ADMIN sends a PATCH request to update a user's role, THEN the system SHALL accept values `admin`, `department_head`, hoặc `user`.
2. WHEN an ADMIN assigns role `department_head` to a user, THEN the request SHALL include a valid `departmentId`, otherwise the system SHALL respond with 400 Bad Request.
3. WHEN an ADMIN changes a user's role from `department_head` to `user` or `admin`, THEN the system SHALL allow the department field to remain or be cleared.
4. WHERE an ADMIN is authenticated, THEY SHALL be able to view all user accounts regardless of department.
5. WHERE an ADMIN is authenticated, THEY SHALL be able to create, activate, deactivate, and update roles for any user.
6. WHEN a non-ADMIN user attempts to call role-assignment endpoints, THEN the system SHALL respond with 403 Forbidden.

#### Correctness Properties

- **P2-Admin-Only-Role-Assign**: Chỉ có tài khoản `admin` mới được gọi endpoint PATCH `/users/:id/role`.
- **P2-DeptHead-Requires-Dept**: Khi gán `department_head`, request phải kèm `departmentId` hợp lệ.

---

### Requirement 3: Trưởng Khoa quản lý tài khoản trong khoa mình

**User Story:** As a DEPARTMENT_HEAD, I want to view and manage user accounts that belong to my department, so that I can oversee my department's personnel without affecting other departments.

#### Acceptance Criteria

1. WHERE a DEPARTMENT_HEAD is authenticated, THEY SHALL only see user accounts where `department.id` matches their own `department.id`.
2. WHEN a DEPARTMENT_HEAD requests the user list, THEN the response SHALL exclude accounts from other departments and ADMIN accounts.
3. WHEN a DEPARTMENT_HEAD attempts to activate/deactivate a user from a different department, THEN the system SHALL respond with 403 Forbidden.
4. WHEN a DEPARTMENT_HEAD attempts to view or edit an ADMIN account, THEN the system SHALL respond with 403 Forbidden.
5. WHEN a DEPARTMENT_HEAD activates or deactivates a user in their department, THEN the change SHALL be persisted and logged in the audit log.
6. IF a DEPARTMENT_HEAD has no department assigned (data integrity issue), THEN all their department-scoped requests SHALL return 403 Forbidden.

#### Correctness Properties

- **P3-Dept-Scope-Isolation**: Với mọi request từ `department_head`, tập kết quả trả về chỉ chứa records thuộc cùng `department_id` với người yêu cầu.
- **P3-No-Cross-Dept-Mutation**: Không có mutation nào từ `department_head` được thành công nếu target resource thuộc khoa khác.

---

### Requirement 4: Trưởng Khoa duyệt tài liệu trong khoa mình

**User Story:** As a DEPARTMENT_HEAD, I want to approve or reject documents uploaded by users in my department, so that I can manage the document workflow for my department without affecting other departments.

#### Acceptance Criteria

1. WHERE a DEPARTMENT_HEAD is authenticated, THEY SHALL be able to view the pending document queue filtered to only documents where `document.department.id` matches their department.
2. WHEN a DEPARTMENT_HEAD approves a document that belongs to their department, THEN the document status SHALL change to `stored` and the file SHALL be moved to the archive directory.
3. WHEN a DEPARTMENT_HEAD rejects a document that belongs to their department, THEN the document status SHALL change to `rejected` and a `rejectReason` SHALL be recorded.
4. WHEN a DEPARTMENT_HEAD attempts to approve or reject a document from a different department, THEN the system SHALL respond with 403 Forbidden.
5. WHEN a DEPARTMENT_HEAD approves a document, THEN the `approvedBy` field SHALL be set to the DEPARTMENT_HEAD's user ID and `approvedAt` SHALL be set to the current timestamp.
6. WHEN a DEPARTMENT_HEAD rejects a document, THEN the action SHALL be recorded in the audit log with the actor's ID and reason.
7. IF a document does not have a `department` assigned, THEN only ADMIN SHALL be able to approve or reject it (DEPARTMENT_HEAD cannot).

#### Correctness Properties

- **P4-Dept-Doc-Approval-Scope**: DEPARTMENT_HEAD chỉ được approve/reject tài liệu có `document.department_id` trùng với `user.department_id` của họ.
- **P4-Audit-Trail**: Mọi hành động approve/reject đều phải tạo một bản ghi trong `audit_log`.
- **P4-Approve-Idempotency**: Tài liệu đã được xử lý (status != PENDING) không thể bị approve/reject lần nữa.

---

### Requirement 5: DEPARTMENT_HEAD xem tài liệu trong khoa mình

**User Story:** As a DEPARTMENT_HEAD, I want to search and browse all documents belonging to my department, so that I have full visibility into my department's document repository.

#### Acceptance Criteria

1. WHERE a DEPARTMENT_HEAD is authenticated, THEY SHALL see all documents (mọi trạng thái) có `department.id` khớp với khoa của họ.
2. WHEN a DEPARTMENT_HEAD searches with a keyword, THEN the search results SHALL be scoped to their department only.
3. WHEN a DEPARTMENT_HEAD attempts to download a document from their department, THEN the system SHALL allow the download regardless of who uploaded it.
4. WHEN a DEPARTMENT_HEAD attempts to download a document from a different department, THEN the system SHALL respond with 403 Forbidden.

#### Correctness Properties

- **P5-Search-Scope**: Kết quả tìm kiếm của DEPARTMENT_HEAD không bao giờ chứa tài liệu thuộc khoa khác.
- **P5-Download-Scope**: DEPARTMENT_HEAD chỉ download được tài liệu thuộc khoa mình hoặc do chính họ upload.

---

### Requirement 6: Ghi nhật ký kiểm tra (Audit Log)

**User Story:** As an ADMIN, I want all role-assignment and document-review actions to be logged, so that I can audit who made changes and when.

#### Acceptance Criteria

1. WHEN an ADMIN changes a user's role, THEN the system SHALL create an audit log entry with `action = 'role_change'`, the actor's ID, target user's ID, old role, and new role.
2. WHEN a DEPARTMENT_HEAD approves or rejects a document, THEN an audit log entry SHALL be created as specified in Requirement 4.
3. WHEN an ADMIN activates or deactivates a user, THEN an audit log entry SHALL be created with `action = 'set_active'`.
4. IF an audit log write fails, THEN the primary operation (role change, approve/reject) SHALL still complete — audit failures SHALL NOT roll back business operations.

#### Correctness Properties

- **P6-Audit-Completeness**: Mọi thay đổi vai trò và duyệt/từ chối tài liệu đều phải tồn tại entry tương ứng trong audit_log.
- **P6-Audit-Non-Blocking**: Lỗi ghi audit log không được làm thất bại operation chính.
