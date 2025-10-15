import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

public class SupabaseExample {
    public static void main(String[] args) throws Exception {
        String supabaseUrl = "https://ypqwcjomnwcoddijvrxl.supabase.co"; // replace with your project URL
        String apiKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlwcXdjam9tbndjb2RkaWp2cnhsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk5NzAyNzAsImV4cCI6MjA3NTU0NjI3MH0.c2UGplGI6s3ZghOkGqOA3BJumli-vOxPuoKTpEKmjPA";
        String table = "api test"; // replace with your table name

        HttpClient client = HttpClient.newHttpClient();
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(supabaseUrl + "/rest/v1/" + table + "?select=*"))
            .header("apikey", apiKey)
            .header("Authorization", "Bearer " + apiKey)
            .header("Content-Type", "application/json")
            .GET()
            .build();

        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        System.out.println(response.body());
    }
}