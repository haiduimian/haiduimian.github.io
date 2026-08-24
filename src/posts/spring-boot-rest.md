---
title: Spring Boot 从零搭建 RESTful API
description: REST 规范、分层架构、参数校验与统一异常处理，一份 Spring Boot 3 开发 REST API 的完整笔记
date: 2025-01-10
category: Java 核心
tags: [Spring Boot, REST, API, MyBatis]
order: 1
slug: spring-boot-rest
---

> 这是仿照原博客「DRF（Django REST Framework）学习笔记」的 Java 版本。原笔记讲 REST 规范与 Django 序列化器，这里用 **Spring Boot 3 + MyBatis** 重写一遍：规范是通用的，框架换成 Java 生态。

## REST 接口规范

**非 REST 设计**，很多人习惯用动词 URL：

```
GET    /admin/getUser    查询用户
POST   /admin/addUser    新增用户
POST   /admin/updateUser 更新用户
POST   /admin/deleteUser 删除用户
```

问题很明显：URL 用动词描述动作，一个资源对应一堆接口，语义混乱。

**REST 设计**，URL 只描述资源，用 HTTP 方法表达动作：

```
GET    /api/users       查询用户列表
GET    /api/users/{id}  查询单个用户
POST   /api/users       新增用户
PUT    /api/users/{id}  更新用户
DELETE /api/users/{id}  删除用户
```

要点：

- **面向资源**：URL 全部是名词复数，动词交给 HTTP 方法
- **HTTP 状态码表达结果**：201 创建成功、404 资源不存在、409 冲突、422 校验失败
- **无状态**：服务端不保存客户端会话状态（JWT / Token 自行携带）

## 项目结构

```
com.example.blog
├── controller   # 控制器层：接收请求、返回响应
├── service      # 业务层：事务、业务规则
├── mapper       # 数据访问层：MyBatis 接口 + XML
├── entity       # 实体类
├── dto          # 请求/响应对象（VO）
└── exception    # 统一异常与全局处理器
```

## 分层职责

| 层 | 职责 | 常见坑 |
|---|---|---|
| Controller | 参数绑定、调用 service、返回 DTO | 在 Controller 里写业务逻辑 |
| Service | 事务边界、业务规则 | 事务方法内部调用 this 的同名私有方法导致事务失效 |
| Mapper | 只做 SQL | 把 SQL 拼在 Java 字符串里 |

## 参数校验与统一异常

DTO 上加 Bean Validation 注解：

```java
public record UserCreateDTO(
    @NotBlank(message = "用户名不能为空") String username,
    @Email(message = "邮箱格式不正确") String email,
    @Min(value = 1, message = "年龄必须大于 0") Integer age
) {}
```

全局异常处理器统一兜底：

```java
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiResult<Void>> handleValid(MethodArgumentNotValidException e) {
        String msg = e.getBindingResult().getFieldErrors().stream()
                .map(FieldError::getDefaultMessage)
                .collect(Collectors.joining("; "));
        return ResponseEntity.badRequest().body(ApiResult.error(400, msg));
    }

    @ExceptionHandler(BusinessException.class)
    public ResponseEntity<ApiResult<Void>> handleBusiness(BusinessException e) {
        return ResponseEntity.status(e.getCode()).body(ApiResult.error(e.getCode(), e.getMessage()));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResult<Void>> handleOther(Exception e) {
        log.error("Unhandled exception", e);
        return ResponseEntity.status(500).body(ApiResult.error(500, "服务器内部错误"));
    }
}
```

这样 Controller 里就不用写 try-catch，业务代码干净很多。

## 完整 CRUD 示例

```java
@RestController
@RequestMapping("/api/users")
@RequiredArgsConstructor
public class UserController {

    private final UserService userService;

    @GetMapping
    public ApiResult<List<UserVO>> list() {
        return ApiResult.success(userService.list());
    }

    @GetMapping("/{id}")
    public ApiResult<UserVO> get(@PathVariable Long id) {
        return ApiResult.success(userService.getById(id));
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public ApiResult<UserVO> create(@Valid @RequestBody UserCreateDTO dto) {
        return ApiResult.success(userService.create(dto));
    }

    @PutMapping("/{id}")
    public ApiResult<UserVO> update(@PathVariable Long id,
                                    @Valid @RequestBody UserUpdateDTO dto) {
        return ApiResult.success(userService.update(id, dto));
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable Long id) {
        userService.delete(id);
    }
}
```

Service 层做事务控制：

```java
@Service
@RequiredArgsConstructor
public class UserService {

    private final UserMapper userMapper;

    @Transactional
    public UserVO create(UserCreateDTO dto) {
        User user = new User();
        user.setUsername(dto.username());
        user.setEmail(dto.email());
        userMapper.insert(user);   // 插入用户
        userMapper.insertLog("user.create", user.getId()); // 记录操作日志
        return UserVO.from(user);
    }
}
```

> ⚠️ 容易踩的坑：`@Transactional` 加在**私有方法**上不生效；同类内部 `this` 调用也不会走代理。事务要放在 public 方法上，且通过外部 Bean 调用。

## 统一响应体

```java
public record ApiResult<T>(int code, String message, T data) {
    public static <T> ApiResult<T> success(T data) {
        return new ApiResult<>(0, "ok", data);
    }
    public static <T> ApiResult<T> error(int code, String message) {
        return new ApiResult<>(code, message, null);
    }
}
```

## 分页

```java
@GetMapping
public ApiResult<PageResult<UserVO>> page(@RequestParam(defaultValue = "1") int page,
                                          @RequestParam(defaultValue = "10") int size) {
    PageHelper.startPage(page, size);
    List<User> list = userMapper.selectAll();
    PageInfo<User> info = new PageInfo<>(list);
    return ApiResult.success(PageResult.of(info.getList(), info.getTotal(), page, size));
}
```

## 小结

- URL 面向资源，方法表达动作，状态码表达结果
- 分层清晰：Controller 薄、Service 管事务、Mapper 管 SQL
- 参数校验 + 全局异常，Controller 里不写 try-catch
- 统一响应体，前端对接省心

REST 规范与语言无关，Django 的 DRF 和 Spring Boot 只是不同实现。换到 Java 生态后，重点变成：注解驱动、事务代理机制、以及 MyBatis 的 XML 映射。