import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.IOException;
import java.io.StringWriter;
import java.io.StringReader;
import java.lang.reflect.Method;
import java.math.BigDecimal;
import java.net.URL;
import java.net.URLClassLoader;
import java.sql.*;
import java.util.*;

public class JdbcExecutor {

    // Lightweight JSON Parser
    static class JsonParser {
        private String str;
        private int pos;

        public JsonParser(String str) {
            this.str = str;
            this.pos = 0;
            skipWhitespace();
        }

        private void skipWhitespace() {
            while (pos < str.length() && Character.isWhitespace(str.charAt(pos))) {
                pos++;
            }
        }

        private char peek() {
            skipWhitespace();
            return pos < str.length() ? str.charAt(pos) : '\0';
        }

        private char consume() {
            char c = str.charAt(pos++);
            skipWhitespace();
            return c;
        }

        private String readString() {
            consume(); // consume '"'
            StringBuilder sb = new StringBuilder();
            while (pos < str.length()) {
                char c = str.charAt(pos++);
                if (c == '"') {
                    skipWhitespace();
                    return sb.toString();
                }
                if (c == '\\') {
                    char next = str.charAt(pos++);
                    switch (next) {
                        case '"': sb.append('"'); break;
                        case '\\': sb.append('\\'); break;
                        case '/': sb.append('/'); break;
                        case 'b': sb.append('\b'); break;
                        case 'f': sb.append('\f'); break;
                        case 'n': sb.append('\n'); break;
                        case 'r': sb.append('\r'); break;
                        case 't': sb.append('\t'); break;
                        case 'u':
                            String hex = str.substring(pos, pos + 4);
                            pos += 4;
                            sb.append((char) Integer.parseInt(hex, 16));
                            break;
                        default: sb.append(next);
                    }
                } else {
                    sb.append(c);
                }
            }
            throw new RuntimeException("Unterminated string");
        }

        private Number readNumber() {
            int start = pos;
            boolean isFloat = false;
            while (pos < str.length()) {
                char c = str.charAt(pos);
                if (c == '-' || c == '+' || (c >= '0' && c <= '9')) {
                    pos++;
                } else if (c == '.' || c == 'e' || c == 'E') {
                    isFloat = true;
                    pos++;
                } else {
                    break;
                }
            }
            String numStr = str.substring(start, pos);
            skipWhitespace();
            if (isFloat) {
                return Double.parseDouble(numStr);
            } else {
                long val = Long.parseLong(numStr);
                if (val >= Integer.MIN_VALUE && val <= Integer.MAX_VALUE) {
                    return (int) val;
                }
                return val;
            }
        }

        private Boolean readBoolean() {
            if (str.startsWith("true", pos)) {
                pos += 4;
                skipWhitespace();
                return true;
            } else if (str.startsWith("false", pos)) {
                pos += 5;
                skipWhitespace();
                return false;
            }
            throw new RuntimeException("Expected boolean");
        }

        private Object readNull() {
            if (str.startsWith("null", pos)) {
                pos += 4;
                skipWhitespace();
                return null;
            }
            throw new RuntimeException("Expected null");
        }

        public Map<String, Object> parseObject() {
            Map<String, Object> obj = new LinkedHashMap<>();
            if (peek() != '{') throw new RuntimeException("Expected {");
            consume();
            if (peek() == '}') {
                consume();
                return obj;
            }
            while (true) {
                if (peek() != '"') throw new RuntimeException("Expected string key");
                String key = readString();
                if (peek() != ':') throw new RuntimeException("Expected :");
                consume();
                Object value = parseValue();
                obj.put(key, value);
                if (peek() == '}') {
                    consume();
                    return obj;
                }
                if (peek() != ',') throw new RuntimeException("Expected , or }");
                consume();
            }
        }

        public List<Object> parseArray() {
            List<Object> arr = new ArrayList<>();
            if (peek() != '[') throw new RuntimeException("Expected [");
            consume();
            if (peek() == ']') {
                consume();
                return arr;
            }
            while (true) {
                arr.add(parseValue());
                if (peek() == ']') {
                    consume();
                    return arr;
                }
                if (peek() != ',') throw new RuntimeException("Expected , or ]");
                consume();
            }
        }

        public Object parseValue() {
            char c = peek();
            if (c == '"') return readString();
            if (c == '{' || c == '[') return (c == '{') ? parseObject() : parseArray();
            if (c == 't' || c == 'f') return readBoolean();
            if (c == 'n') return readNull();
            if (c == '-' || (c >= '0' && c <= '9')) return readNumber();
            throw new RuntimeException("Unexpected character: " + c + " at position " + pos);
        }

        public Object parse() {
            return parseValue();
        }
    }

    // Lightweight JSON Stringifier
    static class JsonStringifier {
        private StringWriter writer = new StringWriter();

        private void escapeString(String s) {
            writer.write('"');
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                switch (c) {
                    case '"': writer.write("\\\""); break;
                    case '\\': writer.write("\\\\"); break;
                    case '\b': writer.write("\\b"); break;
                    case '\f': writer.write("\\f"); break;
                    case '\n': writer.write("\\n"); break;
                    case '\r': writer.write("\\r"); break;
                    case '\t': writer.write("\\t"); break;
                    default:
                        if (c < 0x20) {
                            writer.write(String.format("\\u%04x", (int) c));
                        } else {
                            writer.write(c);
                        }
                }
            }
            writer.write('"');
        }

        private void writeValue(Object value) {
            if (value == null) {
                writer.write("null");
            } else if (value instanceof String) {
                escapeString((String) value);
            } else if (value instanceof Number) {
                writer.write(value.toString());
            } else if (value instanceof Boolean) {
                writer.write(value.toString());
            } else if (value instanceof Map) {
                writeObject((Map<?, ?>) value);
            } else if (value instanceof List) {
                writeArray((List<?>) value);
            } else {
                escapeString(value.toString());
            }
        }

        private void writeObject(Map<?, ?> map) {
            writer.write('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (!first) writer.write(',');
                first = false;
                escapeString(String.valueOf(entry.getKey()));
                writer.write(':');
                writeValue(entry.getValue());
            }
            writer.write('}');
        }

        private void writeArray(List<?> arr) {
            writer.write('[');
            boolean first = true;
            for (Object item : arr) {
                if (!first) writer.write(',');
                first = false;
                writeValue(item);
            }
            writer.write(']');
        }

        public String toString(Object value) {
            writeValue(value);
            return writer.toString();
        }

        public static String stringify(Object value) {
            return new JsonStringifier().toString(value);
        }
    }

    private static Object normalizeValue(Object value) throws SQLException {
        if (value == null) return null;
        if (value instanceof BigDecimal) {
            // Use toString() to avoid financial precision loss from double conversion
            return value.toString();
        }
        if (value instanceof java.sql.Date) {
            return value.toString();
        }
        if (value instanceof java.sql.Time) {
            return value.toString();
        }
        if (value instanceof java.sql.Timestamp) {
            return value.toString();
        }
        if (value instanceof java.sql.Blob) {
            Blob blob = (Blob) value;
            try {
                long length = blob.length();
                if (length > Integer.MAX_VALUE) {
                    return "<binary " + length + " bytes (too large)>";
                }
                byte[] bytes = blob.getBytes(1, (int) length);
                return Base64.getEncoder().encodeToString(bytes);
            } finally {
                // Always free Blob resources
                blob.free();
            }
        }
        if (value instanceof byte[]) {
            return Base64.getEncoder().encodeToString((byte[]) value);
        }
        if (value instanceof Clob) {
            Clob clob = (Clob) value;
            try {
                long length = clob.length();
                if (length > Integer.MAX_VALUE) {
                    return "<clob " + length + " chars (too large)>";
                }
                return clob.getSubString(1, (int) length);
            } finally {
                // Always free Clob resources
                clob.free();
            }
        }
        return value;
    }

    private static Map<String, Object> createErrorResult(SQLException e, long elapsedMs) {
        // Print stack trace to stderr for debugging (agent doesn't receive stack, but ops can see logs)
        e.printStackTrace();
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("success", false);
        result.put("elapsedMs", elapsedMs);
        Map<String, Object> error = new LinkedHashMap<>();
        error.put("type", "SQLException");
        error.put("message", e.getMessage());
        error.put("sqlState", e.getSQLState());
        error.put("vendorCode", e.getErrorCode());
        result.put("error", error);
        return result;
    }

    private static Map<String, Object> testConnection(
            String jdbcUrl,
            String driverClass,
            List<String> driverJars,
            String username,
            String password
    ) throws Exception {
        long startTime = System.currentTimeMillis();

        URL[] jarUrls = new URL[driverJars.size()];
        for (int i = 0; i < driverJars.size(); i++) {
            jarUrls[i] = new java.io.File(driverJars.get(i)).toURI().toURL();
        }

        try (URLClassLoader loader = new URLClassLoader(jarUrls)) {
            Class<?> driverCls = loader.loadClass(driverClass);
            Driver driver = (Driver) driverCls.getDeclaredConstructor().newInstance();

            Properties props = new Properties();
            if (username != null) props.put("user", username);
            if (password != null) props.put("password", password);

            try (Connection conn = driver.connect(jdbcUrl, props)) {
                DatabaseMetaData meta = conn.getMetaData();
                long elapsedMs = System.currentTimeMillis() - startTime;

                Map<String, Object> result = new LinkedHashMap<>();
                result.put("success", true);
                result.put("elapsedMs", elapsedMs);
                result.put("databaseProductName", meta.getDatabaseProductName());
                result.put("databaseProductVersion", meta.getDatabaseProductVersion());
                result.put("driverName", meta.getDriverName());
                result.put("driverVersion", meta.getDriverVersion());
                return result;
            }
        }
    }

    private static Map<String, Object> execute(
            String jdbcUrl,
            String driverClass,
            List<String> driverJars,
            String username,
            String password,
            String sql,
            List<Object> params,
            int maxRows,
            int timeoutSeconds,
            String sqlKind
    ) throws Exception {
        long startTime = System.currentTimeMillis();

        URL[] jarUrls = new URL[driverJars.size()];
        for (int i = 0; i < driverJars.size(); i++) {
            jarUrls[i] = new java.io.File(driverJars.get(i)).toURI().toURL();
        }

        try (URLClassLoader loader = new URLClassLoader(jarUrls)) {
            Class<?> driverCls = loader.loadClass(driverClass);
            Driver driver = (Driver) driverCls.getDeclaredConstructor().newInstance();

            Properties props = new Properties();
            if (username != null) props.put("user", username);
            if (password != null) props.put("password", password);

            try (Connection conn = driver.connect(jdbcUrl, props)) {
                conn.setAutoCommit(true);

                try (PreparedStatement stmt = conn.prepareStatement(sql)) {
                    stmt.setQueryTimeout(timeoutSeconds);
                    stmt.setMaxRows(maxRows + 1);

                    if (params != null) {
                        for (int i = 0; i < params.size(); i++) {
                            stmt.setObject(i + 1, params.get(i));
                        }
                    }

                    boolean hasResultSet = stmt.execute();
                    long elapsedMs = System.currentTimeMillis() - startTime;

                    Map<String, Object> result = new LinkedHashMap<>();
                    result.put("success", true);
                    result.put("elapsedMs", elapsedMs);
                    result.put("sqlKind", sqlKind);

                    if (hasResultSet) {
                        try (ResultSet rs = stmt.getResultSet()) {
                            ResultSetMetaData rsmd = rs.getMetaData();
                            int colCount = rsmd.getColumnCount();

                            List<String> columns = new ArrayList<>();
                            for (int i = 1; i <= colCount; i++) {
                                columns.add(rsmd.getColumnLabel(i));
                            }

                            List<List<Object>> rows = new ArrayList<>();
                            boolean truncated = false;

                            while (rs.next()) {
                                if (rows.size() >= maxRows) {
                                    truncated = true;
                                    break;
                                }
                                List<Object> row = new ArrayList<>();
                                for (int i = 1; i <= colCount; i++) {
                                    row.add(normalizeValue(rs.getObject(i)));
                                }
                                rows.add(row);
                            }

                            result.put("columns", columns);
                            result.put("rows", rows);
                            result.put("rowCount", rows.size()); // rowCount equals actual rows returned
                            result.put("truncated", truncated);
                            result.put("maxRows", maxRows);
                        }
                    } else {
                        int updateCount = stmt.getUpdateCount();
                        // getUpdateCount() returns -1 when result is not an update count or no more results
                        // Use 0 instead of -1 to avoid exposing negative values
                        int affectedRows = updateCount == -1 ? 0 : updateCount;
                        result.put("affectedRows", affectedRows);
                    }

                    return result;
                }
            }
        }
    }

    public static void main(String[] args) {
        try {
            BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
            StringBuilder input = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                input.append(line).append('\n');
            }

            JsonParser parser = new JsonParser(input.toString());
            Map<String, Object> inputObj = parser.parseObject();

            String action = (String) inputObj.get("action");
            String jdbcUrl = (String) inputObj.get("jdbcUrl");
            String driverClass = (String) inputObj.get("driverClass");
            @SuppressWarnings("unchecked")
            List<String> driverJars = (List<String>) inputObj.get("driverJars");
            String username = (String) inputObj.get("username");
            String password = (String) inputObj.get("password");

            Map<String, Object> result;
            long startTime = System.currentTimeMillis();

            try {
                if ("testConnection".equals(action)) {
                    result = testConnection(jdbcUrl, driverClass, driverJars, username, password);
                } else if ("execute".equals(action)) {
                    String sql = (String) inputObj.get("sql");
                    @SuppressWarnings("unchecked")
                    List<Object> params = (List<Object>) inputObj.get("params");
                    Number maxRowsNum = (Number) inputObj.getOrDefault("maxRows", 500);
                    Number timeoutSecondsNum = (Number) inputObj.getOrDefault("timeoutSeconds", 30);
                    String sqlKind = (String) inputObj.getOrDefault("sqlKind", "query");

                    int maxRows = maxRowsNum.intValue();
                    int timeoutSeconds = timeoutSecondsNum.intValue();

                    result = execute(jdbcUrl, driverClass, driverJars, username, password,
                            sql, params, maxRows, timeoutSeconds, sqlKind);
                } else {
                    long elapsedMs = System.currentTimeMillis() - startTime;
                    Map<String, Object> errorResult = new LinkedHashMap<>();
                    errorResult.put("success", false);
                    errorResult.put("elapsedMs", elapsedMs);
                    Map<String, Object> error = new LinkedHashMap<>();
                    error.put("type", "IllegalArgumentException");
                    error.put("message", "Unknown action: " + action);
                    errorResult.put("error", error);
                    result = errorResult;
                }
            } catch (SQLException e) {
                long elapsedMs = System.currentTimeMillis() - startTime;
                result = createErrorResult(e, elapsedMs);
            } catch (Exception e) {
                // Print stack trace to stderr for debugging
                e.printStackTrace();
                long elapsedMs = System.currentTimeMillis() - startTime;
                Map<String, Object> errorResult = new LinkedHashMap<>();
                errorResult.put("success", false);
                errorResult.put("elapsedMs", elapsedMs);
                Map<String, Object> error = new LinkedHashMap<>();
                error.put("type", e.getClass().getSimpleName());
                // Ensure sensitive data like password is not leaked in error messages
                String message = e.getMessage();
                if (message != null) {
                    message = message.replaceAll("(?i)password[=: ]\\S+", "password=***");
                }
                error.put("message", message);
                errorResult.put("error", error);
                result = errorResult;
            }

            System.out.println(JsonStringifier.stringify(result));

        } catch (Exception e) {
            // Print stack trace to stderr for debugging
            e.printStackTrace();
            Map<String, Object> errorResult = new LinkedHashMap<>();
            errorResult.put("success", false);
            Map<String, Object> error = new LinkedHashMap<>();
            error.put("type", e.getClass().getSimpleName());
            // Ensure sensitive data like password is not leaked in error messages
            String message = e.getMessage();
            if (message != null) {
                message = message.replaceAll("(?i)password[=: ]\\S+", "password=***");
            }
            error.put("message", message);
            errorResult.put("error", error);
            System.out.println(JsonStringifier.stringify(errorResult));
        }
    }
}
