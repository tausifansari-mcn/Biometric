USE Shivamgiri;

CREATE TABLE IF NOT EXISTS PasswordResetRequests (
    ID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    EmployeeID BIGINT NOT NULL,
    EmployeeEmpCode VARCHAR(100) NOT NULL,
    EmployeeName VARCHAR(255) NOT NULL,
    ManagerID BIGINT NOT NULL,
    ManagerEmpCode VARCHAR(100) NOT NULL,
    ManagerName VARCHAR(255) NOT NULL,
    ManagerUniqueCode VARCHAR(255) NOT NULL,
    ProposedPasswordHash VARCHAR(512) NOT NULL,
    Status ENUM('Pending', 'Approved', 'Rejected') NOT NULL DEFAULT 'Pending',
    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ReviewedAt DATETIME NULL,
    ReviewedBy VARCHAR(100) NULL,
    PRIMARY KEY (ID),
    INDEX IX_PasswordResetRequests_Employee (EmployeeEmpCode, CreatedAt),
    INDEX IX_PasswordResetRequests_Manager (ManagerID, Status, CreatedAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
