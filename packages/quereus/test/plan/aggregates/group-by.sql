SELECT d.name, COUNT(*) as employee_count, AVG(u.age) as avg_age
FROM users u
JOIN departments d ON u.dept_id = d.id
WHERE u.age >= 25
GROUP BY d.name
ORDER BY employee_count DESC;
