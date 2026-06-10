USE Shivamgiri;

CREATE TABLE IF NOT EXISTS SupportQueries (
    ID BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    EmployeeID BIGINT NOT NULL,
    EmployeeEmpCode VARCHAR(100) NOT NULL,
    EmployeeName VARCHAR(255) NOT NULL,
    ManagerID BIGINT NOT NULL,
    ManagerEmpCode VARCHAR(100) NOT NULL,
    ManagerName VARCHAR(255) NOT NULL,
    ManagerUniqueCode VARCHAR(255) NOT NULL,
    QueryText TEXT NOT NULL,
    ImageData LONGBLOB NULL,
    ImageName VARCHAR(255) NULL,
    ImageMimeType VARCHAR(100) NULL,
    Status ENUM('Open', 'Solved') NOT NULL DEFAULT 'Open',
    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    SolvedAt DATETIME NULL,
    SolvedBy VARCHAR(100) NULL,
    PRIMARY KEY (ID),
    INDEX IX_SupportQueries_Employee (EmployeeEmpCode, CreatedAt),
    INDEX IX_SupportQueries_Manager (ManagerID, Status, CreatedAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
